import asyncio
import logging
import os
import subprocess
import time
import psycopg
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from live import discover
from live_history import LiveHistory
from sim import MAX_REPLICAS, demo_cluster
from telemetry import PostgreSQLTelemetry, router, stop_task

TICK_SECONDS = 0.5
sim = demo_cluster()
live = None
logger = logging.getLogger(__name__)
clients: set[WebSocket] = set()


async def loop():
    while True:
        try:
            batch = await asyncio.to_thread(live.refresh) if live else sim.tick(time.time())
        except (OSError, subprocess.SubprocessError, ValueError):
            logger.warning("Could not refresh Kubernetes context %s", live.context)
            batch = []
        if batch:
            for ws in list(clients):
                try:
                    await ws.send_json(batch)
                except Exception:
                    clients.discard(ws)
        await asyncio.sleep(2 if live else TICK_SECONDS)


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
    dsn = os.getenv("KUBEVERSE_DATABASE_URL")
    if live and dsn:
        live.history = await asyncio.to_thread(LiveHistory, dsn, live.context)
        initial = [event for event in live.initial_events() if event.get("object")]
        await asyncio.to_thread(live.history.record, live.samples, initial)
    app.state.telemetry = PostgreSQLTelemetry(dsn, sim) if dsn and live is None else None
    app.state.telemetry_disabled_reason = (
        "Simulator analytics are disabled in live Kubernetes mode" if live
        else "KUBEVERSE_DATABASE_URL is missing or empty" if not dsn
        else None
    )
    if app.state.telemetry_disabled_reason:
        logging.getLogger("uvicorn.error").info(app.state.telemetry_disabled_reason)
    task = asyncio.create_task(loop())
    ingestion = asyncio.create_task(app.state.telemetry.ingest()) if app.state.telemetry is not None else None
    try:
        yield
    finally:
        await stop_task(task)
        if ingestion is not None:
            await stop_task(ingestion)
            try:
                await asyncio.to_thread(app.state.telemetry.finish)
            except (psycopg.Error, OSError):
                logger.warning("Could not close simulator history run")


app = FastAPI(title="Kuebec Cluster", lifespan=lifespan)
app.include_router(router)


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


def require_simulator():
    if live:
        raise HTTPException(409, "Live Kubernetes mode is read-only")


def ok(found: bool, action: str, target=None, value=None):
    if app.state.telemetry is not None:
        app.state.telemetry.record_action(action, target, value, found)
    if not found:
        raise HTTPException(404, "not found")
    return {"ok": True}


class Scale(BaseModel):
    replicas: int = Field(ge=0, le=MAX_REPLICAS)


class Toggle(BaseModel):
    enabled: bool


@app.delete("/api/namespaces/{ns}/pods/{name}")
async def demolish(ns: str, name: str):
    require_simulator()
    return ok(sim.delete_pod(ns, name), "delete_pod", f"{ns}/{name}")


@app.put("/api/namespaces/{ns}/deployments/{name}/scale")
async def scale(ns: str, name: str, body: Scale):
    require_simulator()
    return ok(sim.scale(ns, name, body.replicas), "scale", f"{ns}/{name}", body.replicas)


@app.put("/api/namespaces/{ns}/deployments/{name}/sabotage")
async def sabotage(ns: str, name: str, body: Toggle):
    require_simulator()
    return ok(sim.sabotage(ns, name, body.enabled), "sabotage", f"{ns}/{name}", body.enabled)


class Release(BaseModel):
    buggy: bool = False


@app.post("/api/namespaces/{ns}/deployments/{name}/release")
async def release(ns: str, name: str, body: Release):
    require_simulator()
    return ok(sim.release(ns, name, body.buggy), "release", f"{ns}/{name}", body.buggy)


@app.post("/api/namespaces/{ns}/deployments/{name}/rollback")
async def rollback(ns: str, name: str):
    require_simulator()
    return ok(sim.rollback(ns, name), "rollback", f"{ns}/{name}")


@app.put("/api/nodes/{name}/drain")
async def drain(name: str, body: Toggle):
    require_simulator()
    return ok(sim.drain(name, body.enabled), "drain", name, body.enabled)


@app.put("/api/rush-hour")
async def rush_hour(body: Toggle):
    require_simulator()
    return ok(sim.rush_hour(body.enabled), "rush_hour", None, body.enabled)


@app.post("/api/reset")
async def reset():
    require_simulator()
    return ok(sim.reset(), "reset")


@app.put("/api/nodes/{name}/outage")
async def outage(name: str, body: Toggle):
    require_simulator()
    return ok(sim.set_node_outage(name, body.enabled), "node_outage", name, body.enabled)


@app.get("/api/traces/{request_id}")
async def trace(request_id: str):
    if not live or not live.history:
        raise HTTPException(404, "Live request history unavailable")
    return {"request_id": request_id, "hops": await asyncio.to_thread(live.history.trace, request_id)}
