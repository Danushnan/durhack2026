"""Store observed Kubernetes changes and request events for a live session."""

import hashlib
import json
import psycopg
from psycopg.rows import dict_row
import time
from uuid import uuid4


class LiveHistory:
    def __init__(self, dsn, context):
        self.dsn = dsn
        self.run_id = str(uuid4())
        with psycopg.connect(dsn, connect_timeout=5) as db:
            db.execute("""
                CREATE TABLE IF NOT EXISTS live_runs (
                    run_id TEXT PRIMARY KEY, context TEXT NOT NULL, started_at DOUBLE PRECISION NOT NULL
                );
                CREATE TABLE IF NOT EXISTS live_requests (
                    run_id TEXT NOT NULL, event_id TEXT NOT NULL, observed_at DOUBLE PRECISION NOT NULL,
                    ingested_at DOUBLE PRECISION NOT NULL, request_id TEXT, caller TEXT NOT NULL,
                    destination TEXT NOT NULL, source_pod TEXT, method TEXT, route TEXT,
                    http_status INTEGER, latency_ms DOUBLE PRECISION, outcome TEXT NOT NULL, error_kind TEXT,
                    PRIMARY KEY (run_id, event_id)
                );
                CREATE INDEX IF NOT EXISTS live_requests_trace
                    ON live_requests (run_id, request_id, observed_at);
                CREATE INDEX IF NOT EXISTS live_requests_time
                    ON live_requests (run_id, observed_at);
                CREATE TABLE IF NOT EXISTS resource_changes (
                    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, run_id TEXT NOT NULL, observed_at DOUBLE PRECISION NOT NULL,
                    uid TEXT NOT NULL, event_type TEXT NOT NULL, kind TEXT NOT NULL,
                    namespace TEXT, name TEXT NOT NULL, state_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS resource_changes_time
                    ON resource_changes (run_id, observed_at);
                """)
            db.execute("INSERT INTO live_runs VALUES (%s, %s, %s)", (self.run_id, context, time.time()))

    def record(self, samples, changes):
        now = time.time()
        with psycopg.connect(self.dsn, connect_timeout=5) as db, db.cursor() as cursor:
            cursor.executemany("INSERT INTO live_requests VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT DO NOTHING", [
                (self.run_id, sample["event_id"], sample["at"] / 1000, now, sample["request_id"],
                 sample["from"], sample["to"], sample["pod"], sample["method"], sample["route"],
                 sample["status"], sample["latency"], sample["outcome"], sample["error_kind"])
                for sample in samples
            ])
            cursor.executemany("""INSERT INTO resource_changes
                (run_id, observed_at, uid, event_type, kind, namespace, name, state_json)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)""", [
                (self.run_id, now, obj["metadata"]["uid"], change["type"], obj["kind"],
                 obj["metadata"].get("namespace"), obj["metadata"]["name"],
                 json.dumps({key: obj[key] for key in ("spec", "status", "reason", "type")
                             if key in obj}))
                for change in changes if (obj := change.get("object"))
                and obj["kind"] in ("Deployment", "Pod", "Node", "Event")
            ])

    def trace(self, request_id):
        with psycopg.connect(self.dsn, connect_timeout=5, row_factory=dict_row) as db:
            return [dict(row) for row in db.execute("""
                SELECT observed_at, caller, destination, source_pod, method, route,
                       http_status, latency_ms, outcome, error_kind
                FROM live_requests WHERE run_id = %s AND request_id = %s ORDER BY observed_at
                """, (self.run_id, request_id))]


def event_id(namespace, line):
    return hashlib.sha256(f"{namespace}:{line}".encode()).hexdigest()
