"""Generate simulated request measurements and query them in TigerData."""

import asyncio
import logging
import math
import random
from collections import defaultdict
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query, Request
from psycopg import AsyncConnection, Error
from psycopg.rows import dict_row

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/telemetry")
WINDOW = timedelta(seconds=10)
BASELINE = timedelta(minutes=2)
BUCKET = timedelta(seconds=5)
ERROR_THRESHOLD = 0.10

SCHEMA = """
CREATE TABLE IF NOT EXISTS kubeverse_requests (
    observed_at timestamptz NOT NULL,
    demo_id uuid NOT NULL,
    caller text NOT NULL,
    service text NOT NULL,
    latency_ms double precision NOT NULL,
    failed boolean NOT NULL,
    target_unavailable boolean NOT NULL
)
"""

INSERT = """
INSERT INTO kubeverse_requests
    (observed_at, demo_id, caller, service, latency_ms, failed, target_unavailable)
VALUES (%s, %s, %s, %s, %s, %s, %s)
"""


class SimulatedRequests:
    """When an upstream call fails, the next sampling step reflects that failure."""

    def __init__(self, simulator):
        self.simulator = simulator
        self.demo_id = uuid4()
        self.previous_failures = set()

    def sample(self, now, duration):
        edges = self.simulator.traffic()
        inbound = {edge["to"] for edge in edges}
        for key in self.simulator.deployments:
            if key not in inbound:
                deployment = self.simulator.deployments[key]
                ready = any(p.ready and p.namespace == deployment.namespace and p.deployment == deployment.name
                            for p in self.simulator.pods.values())
                edges.append({"from": "external", "to": key, "rps": 8, "healthy": ready})

        rows = []
        failures = set()
        for edge in edges:
            caller, target = edge["from"], edge["to"]
            unavailable = not edge["healthy"]
            failed = unavailable or target in self.previous_failures
            count = edge["rps"] * duration
            count = math.floor(count) + (random.random() < count % 1)
            if count and failed:
                failures.add(caller)
            for _ in range(count):
                baseline = 100 if target == "shop/payments" else 65
                latency = random.uniform(800, 1000) if failed else random.uniform(baseline * .8, baseline * 1.2)
                rows.append((now, self.demo_id, caller, target, latency, failed, unavailable))
        self.previous_failures = failures
        return rows


class TigerTelemetry:
    def __init__(self, dsn, simulator):
        self.dsn = dsn
        self.source = SimulatedRequests(simulator)
        self.ready = False
        self.read_slots = asyncio.Semaphore(4)

    async def connect(self):
        return await AsyncConnection.connect(
            self.dsn, connect_timeout=5, options="-c statement_timeout=5000", row_factory=dict_row
        )

    async def ingest(self):
        while True:
            try:
                async with await self.connect() as conn:
                    await conn.execute(SCHEMA)
                    await conn.execute(
                        "SELECT create_hypertable('kubeverse_requests', by_range('observed_at'), if_not_exists => TRUE)"
                    )
                    await conn.execute("""
                        CREATE INDEX IF NOT EXISTS kubeverse_requests_demo_time
                        ON kubeverse_requests (demo_id, observed_at DESC)
                    """)
                    await conn.commit()
                    while True:
                        now = datetime.now(timezone.utc)
                        rows = self.source.sample(now, 1)
                        async with conn.cursor() as cursor:
                            await cursor.executemany(INSERT, rows)
                        await conn.commit()
                        self.ready = True
                        await asyncio.sleep(1)
            except (Error, OSError) as exc:
                self.ready = False
                logger.warning("TigerData ingestion unavailable (%s); retrying in five seconds", type(exc).__name__)
                await asyncio.sleep(5)

    async def snapshot(self, at):
        async with self.read_slots, await self.connect() as conn:
            demo_id = self.source.demo_id
            bounds = await (await conn.execute("""
                SELECT min(observed_at) AS oldest, max(observed_at) AS latest
                FROM kubeverse_requests WHERE demo_id = %s
            """, (demo_id,))).fetchone()
            latest = bounds["latest"]
            if latest is None:
                return {"status": "waiting"}
            at = min(max(at or latest, bounds["oldest"]), latest)
            metrics = await (await conn.execute("""
                SELECT caller, service, count(*) AS requests,
                       avg(latency_ms) AS latency_ms,
                       avg(failed::int)::float8 AS error_rate
                FROM kubeverse_requests
                WHERE demo_id = %s AND observed_at > %s AND observed_at <= %s
                GROUP BY GROUPING SETS ((caller, service), (service))
            """, (demo_id, at - WINDOW, at))).fetchall()
            baselines = await (await conn.execute("""
                SELECT service, avg(latency_ms) AS latency_ms
                FROM kubeverse_requests
                WHERE demo_id = %s AND observed_at > %s AND observed_at <= %s AND NOT failed
                GROUP BY service HAVING count(*) >= 10
            """, (demo_id, at - WINDOW - BASELINE, at - WINDOW))).fetchall()
            timeline = await (await conn.execute("""
                SELECT time_bucket(INTERVAL '5 seconds', observed_at) AS bucket, service,
                       avg(latency_ms) AS latency_ms,
                       avg(failed::int)::float8 AS error_rate,
                       min(observed_at) FILTER (WHERE failed) AS first_failure,
                       min(observed_at) FILTER (WHERE target_unavailable) AS first_direct_failure
                FROM kubeverse_requests
                WHERE demo_id = %s AND observed_at > %s AND observed_at <= %s
                GROUP BY bucket, service ORDER BY bucket, service
            """, (demo_id, at - BASELINE, at))).fetchall()

        baseline = {row["service"]: row["latency_ms"] for row in baselines}
        services, routes = [], []
        for row in metrics:
            row["rps"] = row["requests"] / WINDOW.total_seconds()
            if row["caller"] is not None:
                routes.append(row)
                continue
            reference = baseline.get(row["service"])
            row["baseline_ms"] = reference
            row["anomaly"] = (reference is not None and row["requests"] >= 5
                              and row["latency_ms"] >= max(reference * 2, reference + 75))
            services.append(row)

        paths = propagation_paths(timeline, self.source.simulator.calls)
        return {"status": "ready", "at": at, **bounds, "services": services, "routes": routes, "incidents": paths}


def propagation_paths(timeline, calls):
    """Report callers whose measured failures follow the latest direct incident."""
    roots = []
    for row in timeline:
        if row["first_direct_failure"] is None:
            continue
        if any(previous["service"] == row["service"]
               and previous["bucket"] == row["bucket"] - BUCKET
               and previous["first_direct_failure"] is None for previous in timeline):
            roots.append(row)
    if not roots:
        return []

    root = max(roots, key=lambda row: row["first_direct_failure"])
    started = root["first_direct_failure"]
    callers = defaultdict(list)
    for caller, service, _ in calls:
        callers[service].append(caller)
    by_service = defaultdict(list)
    for row in timeline:
        by_service[row["service"]].append(row)

    paths = []
    pending = [(root["service"], started, [root["service"]])]
    while pending:
        service, changed_at, path = pending.pop(0)
        paths.append({"service": service, "changed_at": changed_at, "path": path,
                      "timeline": [row for row in by_service[service]
                                   if row["bucket"] >= root["bucket"] - 3 * BUCKET]})
        for caller in callers[service]:
            if caller in path:
                continue
            changed = next((row["first_failure"] for row in by_service[caller]
                            if row["error_rate"] >= ERROR_THRESHOLD and row["first_failure"] is not None
                            and changed_at <= row["first_failure"] <= changed_at + 3 * BUCKET), None)
            if changed is not None:
                pending.append((caller, changed, [*path, caller]))
    return paths


async def stop_task(task):
    task.cancel()
    with suppress(asyncio.CancelledError):
        await task


@router.get("")
async def telemetry(request: Request, at: datetime | None = Query(default=None)):
    store = request.app.state.telemetry
    if store is None:
        return {"status": "disabled"}
    if not store.ready:
        return {"status": "connecting"}
    if at is not None and at.utcoffset() is None:
        raise HTTPException(422, "Historical timestamps must include a timezone")
    try:
        return await store.snapshot(at)
    except (Error, OSError):
        raise HTTPException(503, "TigerData query unavailable") from None
