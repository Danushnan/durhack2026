import asyncio
import logging
import os
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlsplit

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from live import discover
from live_history import LiveHistory, router as live_history_router
from sim import MAX_REPLICAS, demo_cluster
from telemetry import TigerTelemetry, router, stop_task

TICK_SECONDS = 0.5
sim = demo_cluster()
live = None
logger = logging.getLogger(__name__)
clients: set[WebSocket] = set()
telemetry_clients: set[WebSocket] = set()
send_locks: dict[WebSocket, asyncio.Lock] = {}


def discard_client(ws):
    clients.discard(ws)
    telemetry_clients.discard(ws)
    send_locks.pop(ws, None)


async def send_batch(ws, batch):
    async with send_locks[ws]:
        await asyncio.wait_for(ws.send_json(batch), timeout=2)


async def broadcast(batch, metrics=None):
    async def deliver(ws):
        payload = batch + [metrics] if metrics is not None and ws in telemetry_clients else batch
        if payload:
            try:
                await send_batch(ws, payload)
            except Exception:
                discard_client(ws)
    await asyncio.gather(*(deliver(ws) for ws in list(clients)))


async def loop():
    pending = {}
    try:
        while True:
            batch = []
            if live:
                for name, refresh in (("resources", live.refresh_resources), ("logs", live.collect_logs)):
                    task = pending.get(name)
                    if task is not None and task.done():
                        try:
                            batch.extend(task.result())
                        except (OSError, subprocess.SubprocessError, ValueError, KeyError, TypeError) as exc:
                            reason = f"Could not refresh Kubernetes {name} ({type(exc).__name__})"
                            logger.warning("%s in context %s", reason, live.context)
                            if name == "resources":
                                live.telemetry.resource_failed(reason)
                        pending.pop(name)
                    if name not in pending:
                        pending[name] = asyncio.create_task(asyncio.to_thread(refresh))
                now = time.time()
                batch.extend(live.update_traffic())
                batch.append(live.telemetry.health_event(now))
                metrics = live.telemetry.snapshot(now)
            else:
                batch = sim.tick(time.time())
                metrics = None
            await broadcast(batch, metrics)
            await asyncio.sleep(2 if live else TICK_SECONDS)
    finally:
        for task in pending.values():
            task.cancel()
        await asyncio.gather(*pending.values(), return_exceptions=True)


@asynccontextmanager
async def lifespan(app):
    global live
    load_dotenv(Path(__file__).with_name(".env"))
    live = None
    context = os.getenv("KUBEVERSE_CONTEXT")
    if os.getenv("KUBEVERSE_MODE") != "sim":
        try:
            live = await asyncio.to_thread(discover, context)
        except (OSError, subprocess.SubprocessError):
            if context:
                raise
        if (context or os.getenv("KUBEVERSE_MODE") == "live") and live is None:
            raise RuntimeError(f"Kubernetes context unavailable: {context}")
    if live is None:
        if os.getenv("KUBEVERSE_MODE") != "sim":
            logger.warning("No Kubernetes source discovered; starting the simulator (SOURCE context=null)")
        sim.tick(time.time())
    dsn = os.environ.get("TIGERDATA_DATABASE_URL")
    app.state.telemetry = TigerTelemetry(dsn, sim) if dsn and live is None else None
    history_dsn = os.getenv("KUBEVERSE_LIVE_HISTORY_DATABASE_URL")
    app.state.live_history_dsn = history_dsn
    history = LiveHistory(history_dsn, live.telemetry) if history_dsn and live else None
    task = asyncio.create_task(loop())
    ingestion = asyncio.create_task(app.state.telemetry.ingest()) if app.state.telemetry is not None else None
    try:
        yield
    finally:
        try:
            await stop_task(task)
        finally:
            if history is not None:
                await asyncio.to_thread(history.stop)
            if ingestion is not None:
                await stop_task(ingestion)


app = FastAPI(title="Kuebec Cluster", lifespan=lifespan)
app.include_router(router)
app.include_router(live_history_router)


@app.websocket("/ws")
async def watch(ws: WebSocket):
    await ws.accept()
    send_locks[ws] = asyncio.Lock()
    if ws.query_params.get("telemetry") == "1":
        telemetry_clients.add(ws)
    try:
        # Register under the same lock used by broadcasts, so the initial
        # snapshot always precedes updates even when a refresh finishes here.
        async with send_locks[ws]:
            clients.add(ws)
            initial = live.initial_events() if live else sim.initial_events()
            if live:
                initial.append(live.telemetry.health_event(time.time()))
                if ws in telemetry_clients:
                    initial.append(live.telemetry.snapshot(time.time()))
            await asyncio.wait_for(ws.send_json(initial), timeout=2)
        while True:
            await ws.receive_text()  # we never expect messages; this just detects disconnect
    except WebSocketDisconnect:
        pass
    finally:
        discard_client(ws)


class DemoPackets(BaseModel):
    count: int = Field(ge=1, le=100, strict=True)
    cross_district: bool = Field(default=False, strict=True)


async def broadcast_demo(request: Request, event):
    # These commands change the illustration only and never enter the telemetry pipeline.
    local_hosts = {'localhost', '127.0.0.1', '::1'}
    origin = request.headers.get('origin')
    if (not request.client or request.client.host not in local_hosts or request.url.hostname not in local_hosts
            or (origin is not None and urlsplit(origin).hostname not in local_hosts)):
        raise HTTPException(403, 'Local demo access only')
    if not telemetry_clients:
        raise HTTPException(409, 'Open the Kuebec map and wait for it to connect first')
    await broadcast([], event)


@app.post('/api/demo/packets')
async def send_demo_packets(body: DemoPackets, request: Request):
    await broadcast_demo(request, {'type': 'DEMO_PACKETS', **body.model_dump()})
    return {'sent': body.count}


@app.post('/api/demo/packets/reset')
async def reset_demo_packets(request: Request):
    await broadcast_demo(request, {'type': 'DEMO_PACKETS_RESET'})
    return {'reset': True}


def require_simulator():
    if live:
        raise HTTPException(409, "Live Kubernetes mode is read-only")


def ok(found: bool):
    if not found:
        raise HTTPException(404, "not found")
    return {"ok": True}


class Scale(BaseModel):
    replicas: int = Field(ge=0, le=MAX_REPLICAS)


class Toggle(BaseModel):
    enabled: bool


@app.delete("/api/namespaces/{ns}/pods/{name}")
def demolish(ns: str, name: str):
    require_simulator()
    return ok(sim.delete_pod(ns, name))


@app.put("/api/namespaces/{ns}/deployments/{name}/scale")
def scale(ns: str, name: str, body: Scale):
    require_simulator()
    return ok(sim.scale(ns, name, body.replicas))


@app.put("/api/namespaces/{ns}/deployments/{name}/sabotage")
def sabotage(ns: str, name: str, body: Toggle):
    require_simulator()
    return ok(sim.sabotage(ns, name, body.enabled))


class Release(BaseModel):
    buggy: bool = False


@app.post("/api/namespaces/{ns}/deployments/{name}/release")
def release(ns: str, name: str, body: Release):
    require_simulator()
    return ok(sim.release(ns, name, body.buggy))


@app.post("/api/namespaces/{ns}/deployments/{name}/rollback")
def rollback(ns: str, name: str):
    require_simulator()
    return ok(sim.rollback(ns, name))


@app.put("/api/nodes/{name}/drain")
def drain(name: str, body: Toggle):
    require_simulator()
    return ok(sim.drain(name, body.enabled))


@app.put("/api/rush-hour")
def rush_hour(body: Toggle):
    require_simulator()
    return ok(sim.rush_hour(body.enabled))


@app.post("/api/reset")
def reset():
    require_simulator()
    return ok(sim.reset())


@app.put("/api/nodes/{name}/outage")
def outage(name: str, body: Toggle):
    require_simulator()
    return ok(sim.set_node_outage(name, body.enabled))
