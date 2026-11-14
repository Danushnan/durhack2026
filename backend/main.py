import asyncio
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from sim import MAX_REPLICAS, demo_cluster
from telemetry import TigerTelemetry, router, stop_task

TICK_SECONDS = 0.5
sim = demo_cluster()
clients: set[WebSocket] = set()


async def loop():
    while True:
        batch = sim.tick(time.time())
        if batch:
            for ws in list(clients):
                try:
                    await ws.send_json(batch)
                except Exception:
                    clients.discard(ws)
        await asyncio.sleep(TICK_SECONDS)


@asynccontextmanager
async def lifespan(app):
    load_dotenv(Path(__file__).with_name(".env"))
    dsn = os.environ.get("TIGERDATA_DATABASE_URL")
    app.state.telemetry = TigerTelemetry(dsn, sim) if dsn else None
    sim.tick(time.time())
    task = asyncio.create_task(loop())
    ingestion = asyncio.create_task(app.state.telemetry.ingest()) if dsn else None
    try:
        yield
    finally:
        await stop_task(task)
        if ingestion is not None:
            await stop_task(ingestion)


app = FastAPI(title="KubeVerse Simulated Cluster", lifespan=lifespan)
app.include_router(router)


@app.websocket("/ws")
async def watch(ws: WebSocket):
    await ws.accept()
    await ws.send_json(sim.initial_events())
    clients.add(ws)
    try:
        while True:
            await ws.receive_text()  # we never expect messages; this just detects disconnect
    except WebSocketDisconnect:
        clients.discard(ws)


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
    return ok(sim.delete_pod(ns, name))


@app.put("/api/namespaces/{ns}/deployments/{name}/scale")
def scale(ns: str, name: str, body: Scale):
    return ok(sim.scale(ns, name, body.replicas))


@app.put("/api/namespaces/{ns}/deployments/{name}/sabotage")
def sabotage(ns: str, name: str, body: Toggle):
    return ok(sim.sabotage(ns, name, body.enabled))


@app.put("/api/nodes/{name}/outage")
def outage(name: str, body: Toggle):
    return ok(sim.set_node_outage(name, body.enabled))
