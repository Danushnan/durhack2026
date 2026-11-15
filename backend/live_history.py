"""Best-effort PostgreSQL history for validated live observations."""

import logging
import time
from queue import Empty, Full, Queue
from threading import Event, Lock, Thread
from typing import Annotated
from uuid import UUID, uuid4

import psycopg
from fastapi import APIRouter, HTTPException, Query, Request
from psycopg.rows import dict_row

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/live-history")

SCHEMA = """
CREATE SCHEMA IF NOT EXISTS kubeverse_live_history_v1;
CREATE TABLE IF NOT EXISTS kubeverse_live_history_v1.runs (
    run_id uuid PRIMARY KEY,
    context text NOT NULL,
    started_at double precision NOT NULL
);
CREATE TABLE IF NOT EXISTS kubeverse_live_history_v1.observations (
    run_id uuid NOT NULL REFERENCES kubeverse_live_history_v1.runs (run_id),
    event_id text NOT NULL,
    application text NOT NULL,
    observed_at double precision NOT NULL,
    service text NOT NULL,
    event text NOT NULL,
    pod_uid text NOT NULL,
    pod text NOT NULL,
    container text NOT NULL,
    runtime_timestamp text,
    request_id text,
    source text,
    target text,
    method text,
    route text,
    operation text,
    status integer NOT NULL,
    latency_ms double precision NOT NULL,
    error text,
    outcome text,
    PRIMARY KEY (run_id, event_id)
);
CREATE INDEX IF NOT EXISTS runs_started
    ON kubeverse_live_history_v1.runs (started_at, run_id);
CREATE INDEX IF NOT EXISTS observations_time
    ON kubeverse_live_history_v1.observations (observed_at, run_id, event_id);
CREATE INDEX IF NOT EXISTS observations_run_time
    ON kubeverse_live_history_v1.observations (run_id, observed_at, event_id);
CREATE INDEX IF NOT EXISTS observations_service_time
    ON kubeverse_live_history_v1.observations (service, observed_at, run_id, event_id);
CREATE INDEX IF NOT EXISTS observations_request_time
    ON kubeverse_live_history_v1.observations (request_id, observed_at, run_id, event_id)
    WHERE request_id IS NOT NULL;
"""

INSERT = """
INSERT INTO kubeverse_live_history_v1.observations (
    run_id, event_id, application, observed_at, service, event, pod_uid, pod, container,
    runtime_timestamp, request_id, source, target, method, route, operation, status,
    latency_ms, error, outcome
) VALUES (
    %(run_id)s, %(event_id)s, %(application)s, %(observed_at)s, %(service)s, %(event)s,
    %(pod_uid)s, %(pod)s, %(container)s, %(runtime_timestamp)s, %(request_id)s,
    %(source)s, %(target)s, %(method)s, %(route)s, %(operation)s, %(status)s,
    %(latency_ms)s, %(error)s, %(outcome)s
) ON CONFLICT (run_id, event_id) DO NOTHING
"""

QUEUE_SIZE = 4096
BATCH_SIZE = 128
SHUTDOWN_TIMEOUT = 5


def connect(dsn, **kwargs):
    return psycopg.connect(
        dsn, connect_timeout=3, options="-c statement_timeout=3000 -c lock_timeout=2000",
        **kwargs,
    )


class LiveHistory:
    def __init__(self, dsn, telemetry):
        self.dsn = dsn
        self.context = telemetry.context
        self.run_id = uuid4()
        self.started_at = time.time()
        self.pending = Queue(maxsize=QUEUE_SIZE)
        self.stopping = Event()
        self.admission = Lock()
        self.overflow = 0
        self.unsubscribe = telemetry.subscribe(self.enqueue)
        self.worker = Thread(target=self.write_loop, name="live-history", daemon=True)
        self.worker.start()

    def enqueue(self, observations):
        with self.admission:
            if self.stopping.is_set():
                return
            for index, observation in enumerate(observations):
                try:
                    self.pending.put_nowait(observation)
                except Full:
                    self.overflow += len(observations) - index
                    break

    def report_overflow(self):
        with self.admission:
            dropped, self.overflow = self.overflow, 0
        if dropped:
            logger.warning("Live history queue full; dropped %d observations", dropped)

    def stop(self):
        self.unsubscribe()
        with self.admission:
            self.stopping.set()
        self.worker.join(SHUTDOWN_TIMEOUT)
        if self.worker.is_alive():
            logger.warning("Live history shutdown timed out; unwritten observations may be lost")

    def next_batch(self):
        try:
            batch = [self.pending.get(timeout=0.25)]
        except Empty:
            return []
        while len(batch) < BATCH_SIZE:
            try:
                batch.append(self.pending.get_nowait())
            except Empty:
                break
        return batch

    def write_loop(self):
        db = None
        batch = []  # Register the run even before its first event.
        try:
            while True:
                rows = [dict(row.as_dict(), run_id=self.run_id) for row in batch]
                for attempt in range(3):
                    try:
                        if db is None:
                            db = connect(self.dsn)
                            with db.transaction():
                                db.execute("SELECT pg_advisory_xact_lock(hashtext('kubeverse_live_history_v1'))")
                                db.execute(SCHEMA)
                                db.execute(
                                    "INSERT INTO kubeverse_live_history_v1.runs (run_id, context, started_at)"
                                    " VALUES (%s, %s, %s)"
                                    " ON CONFLICT (run_id) DO NOTHING",
                                    (self.run_id, self.context, self.started_at),
                                )
                        if rows:
                            with db.transaction(), db.cursor() as cursor:
                                cursor.executemany(INSERT, rows)
                        break
                    except (psycopg.Error, ValueError) as exc:
                        if db is not None:
                            db.close()
                            db = None
                        logger.warning("Live history database write failed (%s, attempt %d/3)",
                                       type(exc).__name__, attempt + 1)
                        if attempt == 2 or self.stopping.wait(0.5 * 2**attempt):
                            if rows:
                                logger.warning("Live history write failed; dropped %d observations", len(rows))
                            break
                self.report_overflow()
                if self.stopping.is_set() and (db is None or self.pending.empty()):
                    break
                batch = self.next_batch()
                while not batch and not self.stopping.is_set():
                    self.report_overflow()
                    batch = self.next_batch()
                if not batch:
                    break
        finally:
            if db is not None:
                db.close()
            remaining = self.pending.qsize()
            if remaining:
                logger.warning("Live history writer stopped; %d queued observations were unwritten", remaining)
            self.report_overflow()


def read_history(request, sql, params):
    dsn = getattr(request.app.state, "live_history_dsn", None)
    if not dsn:
        raise HTTPException(503, "Live history is disabled")
    try:
        with connect(dsn, row_factory=dict_row) as db:
            return db.execute(sql, params).fetchall()
    except (psycopg.Error, ValueError) as exc:
        logger.warning("Live history database read failed (%s)", type(exc).__name__)
        raise HTTPException(503, "Live history database unavailable") from exc


Limit = Annotated[int, Query(ge=1, le=500)]
EpochSeconds = Annotated[float, Query(ge=0, le=253402300799)]
Filter = Annotated[str, Query(min_length=1, max_length=1024)]


@router.get("/runs")
def list_runs(request: Request, limit: Limit = 100):
    return {"runs": read_history(request, """
        SELECT run_id, context, started_at FROM kubeverse_live_history_v1.runs
        ORDER BY started_at DESC, run_id DESC LIMIT %s
    """, (limit,))}


@router.get("/observations")
def list_observations(
    request: Request, run_id: UUID | None = None, start: EpochSeconds | None = None,
    end: EpochSeconds | None = None, service: Filter | None = None,
    request_id: Filter | None = None, limit: Limit = 100,
):
    if start is not None and end is not None and start >= end:
        raise HTTPException(422, "start must be less than end")
    filters = (
        ("run_id = %s", run_id), ("observed_at >= %s", start), ("observed_at < %s", end),
        ("service = %s", service), ("request_id = %s", request_id),
    )
    clauses = [clause for clause, value in filters if value is not None]
    params = [value for _, value in filters if value is not None]
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    return {"observations": read_history(request, f"""
        SELECT * FROM kubeverse_live_history_v1.observations {where}
        ORDER BY observed_at DESC, run_id DESC, event_id DESC LIMIT %s
    """, [*params, limit])}
