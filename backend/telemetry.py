"""Generate simulated request measurements and query them in PostgreSQL."""

import asyncio
import time
import logging
import math
import random
import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb
from collections import defaultdict, deque
from contextlib import suppress
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Query, Request

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/telemetry")
WINDOW = timedelta(seconds=10)
BASELINE = timedelta(minutes=2)
BUCKET = timedelta(seconds=5)
ERROR_THRESHOLD = 0.10

SCHEMA = """
CREATE TABLE IF NOT EXISTS kubeverse_requests (
    observed_at DOUBLE PRECISION NOT NULL,
    demo_id TEXT NOT NULL,
    caller text NOT NULL,
    service text NOT NULL,
    latency_ms REAL NOT NULL CHECK (latency_ms >= 0),
    failed INTEGER NOT NULL CHECK (failed IN (0, 1)),
    target_unavailable INTEGER NOT NULL CHECK (target_unavailable IN (0, 1))
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
        # The edge's own rates and latency (one source of truth with the city); answered errors only show
        # once the service it calls failed in the previous step, so incidents propagate visibly in order.
        for edge in edges:
            caller, target = edge["from"], edge["to"]
            count = edge["rps"] * duration
            count = math.floor(count) + (random.random() < count % 1)
            refused = round(count * edge.get("refused_rate", 0.0 if edge["healthy"] else 1.0))
            errors = round(count * edge.get("error_rate", 0.0)) if target in self.previous_failures else 0
            if refused + errors:
                failures.add(caller)
            for i in range(count):
                unavailable, failed = i < refused, i < refused + errors
                latency = random.uniform(800, 1000) if failed else (edge.get("latency_ms") or 65) * random.uniform(0.8, 1.2)
                rows.append((now, self.demo_id, caller, target, latency, failed, unavailable))
        self.previous_failures = failures
        return rows


HISTORY_SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY, mode TEXT NOT NULL, started_at DOUBLE PRECISION NOT NULL,
    ended_at DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS demo_actions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(run_id), observed_at DOUBLE PRECISION NOT NULL,
    action TEXT NOT NULL, target TEXT, requested_value JSONB, succeeded BOOLEAN NOT NULL
);
CREATE INDEX IF NOT EXISTS demo_actions_run_time ON demo_actions (run_id, observed_at);
CREATE TABLE IF NOT EXISTS service_routes (
    run_id TEXT NOT NULL REFERENCES runs(run_id), caller TEXT NOT NULL, destination TEXT NOT NULL,
    first_seen DOUBLE PRECISION NOT NULL, last_seen DOUBLE PRECISION NOT NULL,
    PRIMARY KEY (run_id, caller, destination)
);
CREATE TABLE IF NOT EXISTS resource_checkpoints (
    run_id TEXT NOT NULL REFERENCES runs(run_id), observed_at DOUBLE PRECISION NOT NULL,
    state JSONB NOT NULL, PRIMARY KEY (run_id, observed_at)
);
"""


class PostgreSQLTelemetry:
    def __init__(self, dsn, simulator):
        self.dsn = dsn
        self.source = SimulatedRequests(simulator)
        self.ready = False
        self.started_at = time.time()
        self.last_checkpoint = 0
        self.actions = deque()
        self.read_slots = asyncio.Semaphore(4)

    def initialize(self, conn):
        conn.execute(SCHEMA)
        conn.execute(HISTORY_SCHEMA)
        conn.execute("INSERT INTO runs (run_id, mode, started_at) VALUES (%s, 'sim', %s) ON CONFLICT DO NOTHING",
                     (str(self.source.demo_id), self.started_at))
        conn.execute('''
            CREATE INDEX IF NOT EXISTS kubeverse_requests_demo_time
            ON kubeverse_requests (demo_id, observed_at)
        ''')

    def record_action(self, action, target, value, succeeded):
        self.actions.append((str(uuid4()), time.time(), action, target, value, succeeded))

    def finish(self):
        if self.ready or self.actions:
            self.write([], list(self.actions))
            with psycopg.connect(self.dsn, connect_timeout=5) as conn:
                conn.execute("UPDATE runs SET ended_at = %s WHERE run_id = %s",
                             (time.time(), str(self.source.demo_id)))

    def write(self, rows, actions, checkpoint=None):
        records = [
            (at.timestamp(), str(run), caller, service, latency, int(failed), int(unavailable))
            for at, run, caller, service, latency, failed, unavailable in rows
        ]
        with psycopg.connect(self.dsn, connect_timeout=5, row_factory=dict_row) as conn:
            if not self.ready:
                self.initialize(conn)
            with conn.cursor() as cursor:
                cursor.executemany(INSERT, records)
                run_id = str(self.source.demo_id)
                cursor.executemany('''
                    INSERT INTO demo_actions (id, run_id, observed_at, action, target, requested_value, succeeded)
                    VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING
                ''', [(action_id, run_id, at, action, target, Jsonb(value), succeeded)
                      for action_id, at, action, target, value, succeeded in actions])
                routes = {(caller, service, at) for at, _, caller, service, *_ in records}
                cursor.executemany('''
                    INSERT INTO service_routes VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (run_id, caller, destination) DO UPDATE
                    SET last_seen = greatest(service_routes.last_seen, excluded.last_seen)
                ''', [(run_id, caller, service, at, at) for caller, service, at in routes])
                if checkpoint:
                    observed_at, state = checkpoint
                    cursor.execute("INSERT INTO resource_checkpoints VALUES (%s, %s, %s)",
                                   (run_id, observed_at, Jsonb(state)))

    async def ingest(self):
        while True:
            try:
                rows = self.source.sample(datetime.now(timezone.utc), 1)
                actions = list(self.actions)
                now = time.time()
                checkpoint = (now, self.source.simulator.snapshot()) if now - self.last_checkpoint >= 30 else None
                await asyncio.to_thread(self.write, rows, actions, checkpoint)
                for _ in actions:
                    self.actions.popleft()
                if checkpoint:
                    self.last_checkpoint = now
                self.ready = True
                await asyncio.sleep(1)
            except (psycopg.Error, OSError) as exc:
                self.ready = False
                logger.warning("PostgreSQL telemetry unavailable (%s); retrying in five seconds", exc)
                await asyncio.sleep(5)

    async def snapshot(self, at):
        async with self.read_slots:
            return await asyncio.to_thread(self.read, at)

    def read(self, at):
        demo_id = str(self.source.demo_id)
        with psycopg.connect(self.dsn, connect_timeout=5, row_factory=dict_row) as conn:
            raw = conn.execute('''
                SELECT min(observed_at) AS oldest, max(observed_at) AS latest
                FROM kubeverse_requests WHERE demo_id = %s
            ''', (demo_id,)).fetchone()
            if raw["latest"] is None:
                return {"status": "waiting"}
            bounds = {key: datetime.fromtimestamp(raw[key], timezone.utc) for key in raw.keys()}
            at = min(max(at or bounds["latest"], bounds["oldest"]), bounds["latest"])
            metrics = [dict(row) for row in conn.execute('''
                WITH recent AS (
                    SELECT * FROM kubeverse_requests
                    WHERE demo_id = %s AND observed_at > %s AND observed_at <= %s
                )
                SELECT caller, service, count(*) AS requests,
                       avg(latency_ms) AS latency_ms, avg(failed) AS error_rate
                FROM recent GROUP BY caller, service
                UNION ALL
                SELECT NULL, service, count(*), avg(latency_ms), avg(failed)
                FROM recent GROUP BY service
            ''', (demo_id, (at - WINDOW).timestamp(), at.timestamp()))]
            baselines = conn.execute('''
                SELECT service, avg(latency_ms) AS latency_ms
                FROM kubeverse_requests
                WHERE demo_id = %s AND observed_at > %s AND observed_at <= %s AND failed = 0
                GROUP BY service HAVING count(*) >= 10
            ''', (demo_id, (at - WINDOW - BASELINE).timestamp(), (at - WINDOW).timestamp())).fetchall()
            timeline = [dict(row) for row in conn.execute('''
                SELECT floor(observed_at / 5) * 5 AS bucket, service,
                       avg(latency_ms) AS latency_ms, avg(failed) AS error_rate,
                       min(observed_at) FILTER (WHERE failed = 1) AS first_failure,
                       min(observed_at) FILTER (WHERE target_unavailable = 1) AS first_direct_failure
                FROM kubeverse_requests
                WHERE demo_id = %s AND observed_at > %s AND observed_at <= %s
                GROUP BY bucket, service ORDER BY bucket, service
            ''', (demo_id, (at - BASELINE).timestamp(), at.timestamp()))]
            actions = conn.execute('''
                SELECT id, observed_at, action, target, requested_value, succeeded
                FROM demo_actions WHERE run_id = %s AND observed_at <= %s
                ORDER BY observed_at DESC LIMIT 30
            ''', (demo_id, bounds["latest"].timestamp())).fetchall()
        for row in timeline:
            for key in ("bucket", "first_failure", "first_direct_failure"):
                if row[key] is not None:
                    row[key] = datetime.fromtimestamp(row[key], timezone.utc)

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
        return {"status": "ready", "at": at, **bounds, "services": services, "routes": routes, "incidents": paths, "actions": actions}


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
        return {"status": "disabled", "reason": request.app.state.telemetry_disabled_reason}
    if not store.ready:
        return {"status": "connecting"}
    if at is not None and at.utcoffset() is None:
        raise HTTPException(422, "Historical timestamps must include a timezone")
    try:
        return await store.snapshot(at)
    except (psycopg.Error, OSError):
        raise HTTPException(503, "PostgreSQL telemetry query unavailable") from None
