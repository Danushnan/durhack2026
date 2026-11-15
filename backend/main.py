import asyncio
import logging
import os
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path
from random import shuffle
from typing import Literal

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from live import discover
from sim import MAX_REPLICAS, demo_cluster
from telemetry import TigerTelemetry, router, stop_task

TICK_SECONDS = 0.5
sim = demo_cluster()
live = None
logger = logging.getLogger(__name__)
clients: set[WebSocket] = set()
shop_origins = [f"http://{host}:{port}" for host in ("localhost", "127.0.0.1") for port in (8080, 18080)]


async def broadcast(batch):
    for ws in list(clients):
        try:
            await ws.send_json(batch)
        except (RuntimeError, WebSocketDisconnect, OSError):
            clients.discard(ws)


async def loop():
    while True:
        started = time.monotonic()
        try:
            batch = await asyncio.to_thread(live.refresh) if live else sim.tick(time.time())
        except (OSError, subprocess.SubprocessError, ValueError):
            logger.warning("Could not refresh Kubernetes context %s", live.context)
            batch = []
        if batch:
            await broadcast(batch)
        await asyncio.sleep(max(0, 1 - (time.monotonic() - started)) if live else TICK_SECONDS)


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
        if context and live is None:
            raise RuntimeError(f"Kubernetes context unavailable: {context}")
    if live is None:
        sim.tick(time.time())
    dsn = os.environ.get("TIGERDATA_DATABASE_URL")
    app.state.telemetry = TigerTelemetry(dsn, sim, live=live) if dsn else None
    task = asyncio.create_task(loop())
    ingestion = asyncio.create_task(app.state.telemetry.ingest()) if app.state.telemetry is not None else None
    try:
        yield
    finally:
        await stop_task(task)
        if ingestion is not None:
            await stop_task(ingestion)


app = FastAPI(title="Kuebec Cluster", lifespan=lifespan)
app.include_router(router)
app.add_middleware(CORSMiddleware, allow_origins=shop_origins, allow_methods=["POST"], allow_headers=["Content-Type"])


@app.websocket("/ws")
async def watch(ws: WebSocket):
    await ws.accept()
    await ws.send_json(live.initial_events() if live else sim.initial_events())
    clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # we never expect messages; this just detects disconnect
    except WebSocketDisconnect:
        clients.discard(ws)


class DemoTraffic(BaseModel):
    count: Literal[1, 5, 100]
    cross_district: bool


def demo_pairs(workloads, cross_district, count):
    """Take one destination per caller before repeating a caller."""
    candidates = {}
    for source, namespace in workloads:
        targets = [target for target, district in workloads
                   if target != source and (district != namespace) == cross_district]
        if targets:
            shuffle(targets)
            candidates[source] = targets
    if not candidates:
        return []
    sources = list(candidates)
    shuffle(sources)
    pairs = []
    while len(pairs) < count:
        for source in sources:
            pairs.append((source, candidates[source].pop()))
            if len(pairs) == count:
                break
        sources = [source for source in sources if candidates[source]]
        if not sources:
            return (pairs * count)[:count]
    return pairs


def require_demo_city(request: Request):
    if request.headers.get("origin") not in shop_origins:
        raise HTTPException(403, "Open the local MiniShop storefront to send demo traffic.")
    if not live or not clients:
        raise HTTPException(409, "Open the live Kuebec city first.")


@app.post("/api/demo/traffic")
async def spawn_demo_traffic(body: DemoTraffic, request: Request):
    require_demo_city(request)
    workloads = [(f'{obj["metadata"]["namespace"]}/{obj["metadata"]["name"]}', obj["metadata"]["namespace"])
                 for obj in live.objects.values() if obj["kind"] == "Deployment"]
    pairs = demo_pairs(workloads, body.cross_district, body.count)
    if not pairs:
        detail = "Two districts with buildings are needed." if body.cross_district else "A district needs at least two buildings."
        raise HTTPException(409, detail)
    await broadcast([{"type": "DEMO_TRAFFIC", "edges": [
        {"from": source, "to": target, "rps": 0, "healthy": True} for source, target in pairs
    ]}])
    return {"sent": len(pairs)}


@app.post("/api/demo/traffic/reset")
async def reset_demo_traffic(request: Request):
    require_demo_city(request)
    await broadcast([{"type": "DEMO_RESET"}])
    return {"ok": True}


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
