import asyncio
import time
import logging
import os
import subprocess
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, Field

from live import discover
from sim import MAX_REPLICAS, demo_cluster

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
async def lifespan(_):
    global live
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
    task = asyncio.create_task(loop())
    yield
    task.cancel()


app = FastAPI(title="KubeVerse Simulated Cluster", lifespan=lifespan)


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


@app.put("/api/nodes/{name}/outage")
def outage(name: str, body: Toggle):
    require_simulator()
    return ok(sim.set_node_outage(name, body.enabled))
