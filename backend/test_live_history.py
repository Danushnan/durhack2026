import json
import os
import socket
import threading
import time
from contextlib import nullcontext

import pytest
from fastapi.testclient import TestClient
from psycopg.conninfo import conninfo_to_dict

import live_history
import main
from live import LiveCluster
from live_history import LiveHistory
from test_live_pipeline import resources
from test_live_telemetry import iso, parse, pod, record


@pytest.fixture
def live_cluster(monkeypatch):
    monkeypatch.setattr(main, "load_dotenv", lambda path: None)
    monkeypatch.delenv("TIGERDATA_DATABASE_URL", raising=False)
    monkeypatch.setenv("KUBEVERSE_MODE", "live")
    cluster = LiveCluster("history-test-context")
    monkeypatch.setattr(main, "discover", lambda context: cluster)
    return cluster


def test_postgres_collector_overlap_and_history_after_restart(live_cluster, monkeypatch):
    dsn = os.getenv("KUBEVERSE_LIVE_HISTORY_TEST_DATABASE_URL")
    if not dsn:
        pytest.skip("Set KUBEVERSE_LIVE_HISTORY_TEST_DATABASE_URL to a disposable PostgreSQL database")
    assert conninfo_to_dict(dsn).get("dbname") == "kubeverse_history_test"
    monkeypatch.setenv("KUBEVERSE_LIVE_HISTORY_DATABASE_URL", dsn)
    stamp = int((time.time() - 0.5) * 1000) / 1000
    pods = [pod(), pod("checkout-api", "checkout-1")]
    payloads = [record(stamp, latency=123.45), record(
        stamp, service="checkout-api", event="dependency", source="checkout-api",
        target="postgres", method=None, route=None, operation="sql.select",
    )]
    logs = [f"{iso(stamp)} {json.dumps(payload)}" for payload in payloads]
    overlap = threading.Event()
    payment_reads = 0

    def kubectl(*args):
        nonlocal payment_reads
        if "get" in args:
            return resources(pods)
        if pods[0]["name"] in args:
            payment_reads += 1
        return next(log for p, log in zip(pods, logs) if p["name"] in args)

    monkeypatch.setattr("live.kubectl", kubectl)
    accepted = []
    live_cluster.telemetry.subscribe(accepted.extend)
    collect_logs = live_cluster.collect_logs

    def collect():
        result = collect_logs()
        if payment_reads >= 2:
            overlap.set()
        return result

    monkeypatch.setattr(live_cluster, "collect_logs", collect)
    writers = []

    def history_writer(*args):
        writer = LiveHistory(*args)
        writers.append(writer)
        return writer

    monkeypatch.setattr(main, "LiveHistory", history_writer)
    with TestClient(main.app) as client:
        assert overlap.wait(10), "expected overlapping Kubernetes log reads"
        assert len(accepted) == 2
        writer = writers[0]
        run_id = str(writer.run_id)
        # Force an identical handoff as well to exercise the database's conflict key.
        writer.enqueue(tuple(accepted))
        deadline = time.monotonic() + 10
        while True:
            response = client.get("/api/live-history/observations", params={
                "run_id": run_id, "start": stamp, "end": stamp + 0.001,
                "request_id": payloads[0]["request_id"],
            })
            rows = response.json().get("observations", [])
            if len(rows) == 2 or time.monotonic() >= deadline:
                break
            time.sleep(0.05)
        assert len(rows) == 2, response.text

    # Reopen the app lifespan with a new collector and no rediscovered events.
    restarted = LiveCluster(live_cluster.context)
    monkeypatch.setattr(main, "discover", lambda context: restarted)
    monkeypatch.setattr(restarted, "collect_logs", lambda: [])
    with TestClient(main.app) as client:
        response = client.get("/api/live-history/runs")
        runs = {row["run_id"]: row for row in response.json()["runs"]}
        assert runs[run_id]["context"] == live_cluster.context
        response = client.get("/api/live-history/observations", params={"run_id": run_id})
        rows = response.json()["observations"]
        assert len(rows) == 2
        assert {row["event_id"]: row for row in rows} == {
            row.event_id: dict(row.as_dict(), run_id=run_id) for row in accepted
        }
        assert all(row["observed_at"] == stamp for row in rows)
        response = client.get("/api/live-history/observations", params={
            "run_id": run_id, "service": "minishop/payment-api", "limit": 1,
        })
        assert response.json()["observations"] == [
            row for row in rows if row["service"] == "minishop/payment-api"
        ]
        assert client.get("/api/live-history/observations?service=' OR true --").json() == {"observations": []}
        assert client.get("/api/live-history/observations?start=2&end=1").status_code == 422
        assert client.get("/api/live-history/observations?limit=501").status_code == 422


def test_unavailable_postgres_keeps_sending_live_websocket_updates(live_cluster, monkeypatch, caplog):
    now = time.time()
    p = pod()
    log = f"{iso(now)} {json.dumps(record(now))}"
    monkeypatch.setattr("live.kubectl", lambda *args: resources([p]) if "get" in args else log)
    # Reserve a loopback port with no listener to get a genuine connection refusal.
    with socket.socket() as unavailable:
        unavailable.bind(("127.0.0.1", 0))
        port = unavailable.getsockname()[1]
        monkeypatch.setenv("KUBEVERSE_LIVE_HISTORY_DATABASE_URL", f"postgresql://127.0.0.1:{port}/unused")
        with TestClient(main.app) as client, client.websocket_connect("/ws?telemetry=1") as ws:
            assert any(e.get("mode") == "live" for e in ws.receive_json())
            assert client.get("/api/live-history/runs").status_code == 503
            for _ in range(3):
                batch = ws.receive_json()
                metrics = next(e for e in batch if e["type"] == "SERVICE_METRICS")
                payment = next(s for s in metrics["services"] if s["service"] == p["service"])
                if payment["request_count"] == 1:
                    break
            assert payment["request_count"] == 1
            assert any(e["type"] == "HEALTH" for e in batch)
    assert "Live history database write failed" in caplog.text


def test_blocked_insert_does_not_block_telemetry_or_overfill_queue(monkeypatch, caplog):
    entered, release, producer_done = threading.Event(), threading.Event(), threading.Event()

    class SlowDatabase:
        def transaction(self):
            return nullcontext()

        def cursor(self):
            return nullcontext(self)

        def execute(self, *args):
            pass

        def executemany(self, *args):
            entered.set()
            assert release.wait(5), "test did not release the insert"

        def close(self):
            pass

    monkeypatch.setattr(live_history, "QUEUE_SIZE", 1)
    monkeypatch.setattr(live_history, "connect", lambda dsn: SlowDatabase())
    telemetry = LiveCluster("stalled-insert-test").telemetry
    now = time.time()
    history = LiveHistory("fake", telemetry)
    accepted = []

    def collect():
        accepted.extend(telemetry.ingest([parse(record(now, latency=n)) for n in (2, 3, 4)], now))
        producer_done.set()

    try:
        telemetry.ingest([parse(record(now))], now)
        assert entered.wait(2)
        producer = threading.Thread(target=collect, daemon=True)
        producer.start()
        assert producer_done.wait(2), "the collector waited for SQL"
        assert len(accepted) == 3
        assert history.pending.qsize() == 1
    finally:
        release.set()
        history.stop()
    assert "queue full; dropped 2 observations" in caplog.text


@pytest.mark.parametrize("configured", [False, True])
def test_simulator_does_not_start_history_writer(live_cluster, monkeypatch, configured):
    monkeypatch.setenv("KUBEVERSE_MODE", "sim")
    if configured:
        monkeypatch.setenv("KUBEVERSE_LIVE_HISTORY_DATABASE_URL", "unused")
    else:
        monkeypatch.delenv("KUBEVERSE_LIVE_HISTORY_DATABASE_URL", raising=False)
    monkeypatch.setattr(main, "LiveHistory", lambda *args: pytest.fail("simulator started a history writer"))
    with TestClient(main.app) as client, client.websocket_connect("/ws?telemetry=1") as ws:
        batch = ws.receive_json()
        assert {"type": "SOURCE", "context": None} in batch
        assert any(e["type"] == "ADDED" for e in batch)
        if not configured:
            assert client.get("/api/live-history/runs").json() == {"detail": "Live history is disabled"}
