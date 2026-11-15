import asyncio
import json
import subprocess
import threading

import pytest

from live import LiveCluster
from live_telemetry import iso
from test_live_telemetry import COMPONENTS, FIXTURE, NOW, metric, pod, record, setup_engine


def resources(pods):
    items = []
    for name in COMPONENTS:
        items.extend([
            {"kind": "Deployment", "metadata": {"uid": f"dep-{name}", "name": name, "namespace": "minishop"},
             "spec": {"replicas": sum(p["deployment"] == name for p in pods),
                      "template": {"metadata": {"labels": {"app.kubernetes.io/part-of": "kubeverse-demo"}}}}},
            {"kind": "ReplicaSet", "metadata": {"uid": f"rs-{name}", "name": f"{name}-rs", "namespace": "minishop",
             "ownerReferences": [{"uid": f"dep-{name}", "controller": True}]}},
        ])
    for p in pods:
        items.append({"kind": "Pod", "metadata": {"uid": p["uid"], "name": p["name"], "namespace": p["namespace"],
                      "labels": {"app.kubernetes.io/part-of": "kubeverse-demo", "app": p["deployment"]},
                      "ownerReferences": [{"uid": f'rs-{p["deployment"]}', "controller": True}]},
                      "spec": {"nodeName": "node", "containers": [{"name": "workload"}]},
                      "status": {"containerStatuses": [{"name": "workload", "ready": p["ready"],
                                                         "restartCount": p.get("restarts", 0)}]}})
    return json.dumps({"items": items})


def test_collection_mapping_resource_diffs_and_cursor_replays(monkeypatch):
    p = pod()
    calls = []
    def kubectl(*args):
        calls.append(args)
        return resources([p]) if "get" in args else f"{iso(NOW - 1)} {json.dumps(record())}"
    monkeypatch.setattr("live.kubectl", kubectl)
    monkeypatch.setattr("live.time.time", lambda: NOW)
    cluster = LiveCluster("kind-minishop")
    events = cluster.refresh()
    assert any(e["type"] == "ADDED" and e["object"]["kind"] == "Pod" for e in events)
    assert cluster.objects[p["uid"]]["deploymentUid"] == "dep-payment-api"
    assert "labels" not in cluster.objects[p["uid"]]["metadata"]
    assert metric(cluster.telemetry)["request_count"] == 1
    assert cluster.refresh() == []
    assert metric(cluster.telemetry)["request_count"] == 1
    log_calls = [args for args in calls if "logs" in args]
    assert all("--timestamps=true" in args and "--tail=10000" in args for args in log_calls)
    assert f"--since-time={iso(NOW - 12)}" in log_calls[0]
    assert f"--since-time={iso(NOW - 2)}" in log_calls[1]


def test_complete_genuine_fixture_collector_to_asgi_websocket(monkeypatch):
    import main
    data = [json.loads(line) for line in FIXTURE.read_text().splitlines()]
    now = max(r["timestamp_ms"] for r in data if "timestamp_ms" in r) / 1000 + .1
    pods = [pod(name, uid=name) for name in COMPONENTS]
    def kubectl(*args):
        if "get" in args:
            return resources(pods)
        p = next(p for p in pods if p["name"] in args)
        # Keep the archived payloads unchanged. Proxy records lack archived
        # runtime timestamps and correctly remain unavailable in this fixture.
        return "\n".join(json.dumps(r) for r in data if r["service"] == p["deployment"])
    monkeypatch.setattr("live.kubectl", kubectl)
    monkeypatch.setattr("live.time.time", lambda: now)
    cluster = LiveCluster("kind-minishop")
    cluster.refresh()
    assert len(cluster.edges) == 10
    cluster.refresh()
    assert metric(cluster.telemetry, now=now)["request_count"] == 1
    monkeypatch.setattr(main, "live", cluster)
    async def connect(query):
        sent = []
        inputs = iter([{"type": "websocket.connect"}, {"type": "websocket.disconnect", "code": 1000}])
        async def receive():
            return next(inputs)
        async def send(message):
            sent.append(message)
        scope = {"type": "websocket", "asgi": {"version": "3.0"}, "scheme": "ws", "path": "/ws",
                 "raw_path": b"/ws", "query_string": query, "headers": [],
                 "client": ("test", 1234), "server": ("test", 8000), "subprotocols": []}
        await main.app(scope, receive, send)
        assert sent[0]["type"] == "websocket.accept"
        return json.loads(next(m["text"] for m in sent if m["type"] == "websocket.send"))
    plain = asyncio.run(connect(b""))
    opted = asyncio.run(connect(b"telemetry=1"))
    assert all(e["type"] != "SERVICE_METRICS" for e in plain)
    event = next(e for e in opted if e["type"] == "SERVICE_METRICS")
    payment = next(s for s in event["services"] if s["service"] == "minishop/payment-api")
    assert payment["request_count"] == 1 and payment["p95_latency_ms"] == 101.48
    assert next(e for e in opted if e["type"] == "TRAFFIC")["edges"] == cluster.edges


def test_restart_previous_current_overlap_and_replacement(monkeypatch):
    p = pod()
    clock, reads = [NOW], []
    def kubectl(*args):
        if "get" in args:
            return resources([p])
        reads.append(args)
        first = f"{iso(NOW - 1)} {json.dumps(record())}"
        second = f"{iso(NOW + 1)} {json.dumps(record(NOW + 1, latency=200))}"
        return first if "--previous=true" in args or clock[0] == NOW else first + "\n" + second
    monkeypatch.setattr("live.kubectl", kubectl)
    monkeypatch.setattr("live.time.time", lambda: clock[0])
    cluster = LiveCluster("kind-minishop")
    cluster.refresh()
    p["restarts"] = 1
    clock[0] = NOW + 2
    cluster.refresh()
    assert metric(cluster.telemetry, now=clock[0])["request_count"] == 2
    assert sum("--previous=true" in args for args in reads) == 1
    cluster.collect_logs()
    assert sum("--previous=true" in args for args in reads) == 1
    # A replacement's new UID must not collide with the old pod's event IDs.
    p["uid"], p["name"], p["restarts"] = "replacement", "replacement", 0
    changes = cluster.refresh()
    assert any(e["type"] == "DELETED" and e["object"]["metadata"]["uid"] == "pod-1" for e in changes)
    assert metric(cluster.telemetry, now=clock[0])["request_count"] == 4


def test_failed_reads_do_not_advance_cursor_and_recovery_restores_metrics(monkeypatch):
    clock, failed = [NOW], [False]
    p = pod()
    def kubectl(*args):
        if "get" in args:
            return resources([p])
        if failed[0]:
            raise subprocess.TimeoutExpired("kubectl", 15)
        return f"{iso(clock[0] - 1)} {json.dumps(record(clock[0] - 1))}"
    monkeypatch.setattr("live.kubectl", kubectl)
    monkeypatch.setattr("live.time.time", lambda: clock[0])
    cluster = LiveCluster("kind-minishop")
    cluster.refresh()
    failed[0], clock[0] = True, NOW + 2
    cluster.collect_logs()
    assert cluster.log_cursors[p["uid"]] == NOW
    assert metric(cluster.telemetry, now=clock[0])["availability"] == "partial"
    clock[0] = NOW + 12
    assert metric(cluster.telemetry, now=clock[0])["availability"] == "stale"
    cluster.telemetry.resource_failed("Kubernetes unavailable")
    assert cluster.telemetry.snapshot(clock[0])["source"]["status"] == "disconnected"
    assert cluster.telemetry.health_event(clock[0])["stale"]
    failed[0] = False
    cluster.refresh()
    result = metric(cluster.telemetry, now=clock[0])
    assert result["availability"] == "active" and result["request_count"] == 1
    assert result["application_status"] == result["infrastructure_status"] == "healthy"


def test_unrecoverable_previous_container_is_partial_then_ages_out(monkeypatch):
    p, clock = pod(), [NOW]
    p["restarts"] = 1
    def kubectl(*args):
        if "get" in args:
            return resources([p])
        if "--previous=true" in args:
            raise subprocess.CalledProcessError(1, "kubectl")
        return ""
    monkeypatch.setattr("live.kubectl", kubectl)
    monkeypatch.setattr("live.time.time", lambda: clock[0])
    cluster = LiveCluster("kind-minishop")
    cluster.refresh()
    assert metric(cluster.telemetry)["availability"] == "partial"
    assert "Previous logs unavailable" in cluster.telemetry.snapshot(NOW)["source"]["error"]
    clock[0] = NOW + 13
    cluster.refresh()
    assert metric(cluster.telemetry, now=clock[0])["availability"] == "idle"


def test_partial_replica_read_does_not_claim_complete_or_healthy():
    p1, p2 = pod(uid="one"), pod(uid="two")
    engine = setup_engine([p1, p2])
    engine.poll_result(p2["uid"], NOW, since=NOW - 12, error="replica logs failed")
    result = metric(engine)
    assert result["availability"] == "partial" and not result["window_complete"]
    assert result["application_status"] == "unknown" and result["infrastructure_status"] == "healthy"
    assert result["request_count"] is None


def test_multiple_restarts_report_recovery_gap(monkeypatch):
    p = pod()
    p["restarts"] = 3
    monkeypatch.setattr("live.kubectl", lambda *args: resources([p]) if "get" in args else "")
    monkeypatch.setattr("live.time.time", lambda: NOW)
    cluster = LiveCluster("kind-minishop")
    cluster.refresh()
    assert metric(cluster.telemetry)["availability"] == "partial"
    cluster.collect_logs()
    assert "Multiple restarts" in cluster.telemetry.snapshot(NOW)["source"]["error"]


def test_log_cap_marks_partial_data(monkeypatch, caplog):
    p = pod()
    monkeypatch.setattr("live.kubectl", lambda *args: resources([p]) if "get" in args else "startup\n" * 10000)
    monkeypatch.setattr("live.time.time", lambda: NOW)
    cluster = LiveCluster("kind-minishop")
    cluster.refresh()
    result = metric(cluster.telemetry)
    assert not result["window_complete"] and result["availability"] == "partial"
    assert "log limit reached" in caplog.text


def test_merged_roads_persist_without_inventing_requests(monkeypatch):
    monkeypatch.setattr("live.kubectl", lambda *args: resources([]) if "get" in args else "")
    monkeypatch.setattr("live.time.time", lambda: NOW)
    cluster = LiveCluster("kind-minishop")
    cluster.refresh()
    assert len(cluster.edges) == 10
    assert all(edge["requests"] == 0 and edge["rps"] == 0 for edge in cluster.edges)
    assert all(row["request_count"] is None for row in cluster.telemetry.snapshot(NOW)["services"])


def test_merged_edges_keep_business_rejections_separate_from_refusals(monkeypatch):
    p = pod("checkout-api")
    data = record(service="checkout-api", event="http_client", source="checkout-api",
                  target="payment-api.minishop.svc.cluster.local", status=402, error="HTTP 402")
    monkeypatch.setattr("live.kubectl", lambda *args: resources([p]) if "get" in args else json.dumps(data))
    monkeypatch.setattr("live.time.time", lambda: NOW)
    cluster = LiveCluster("kind-minishop")
    cluster.refresh()
    edge = next(e for e in cluster.edges if e["from"] == "minishop/checkout-api" and e["to"] == "minishop/payment-api")
    assert edge["healthy"] and edge["errors"]
    assert edge["error_rate"] == 1 and edge["refused_rate"] == 0
    assert edge["requests"] == 1 and edge["latency_ms"] == 100


def test_new_kubernetes_workload_log_format_reaches_edge_metrics(monkeypatch):
    p = pod("checkout-api")
    data = {"source": "checkout-api", "target": "payment-api", "timestamp_ms": int((NOW - 1) * 1000),
            "status": 500, "latency_ms": 37.5}
    monkeypatch.setattr("live.kubectl", lambda *args: resources([p]) if "get" in args else json.dumps(data))
    monkeypatch.setattr("live.time.time", lambda: NOW)
    cluster = LiveCluster("kind-minishop")
    cluster.refresh()
    edge = next(e for e in cluster.edges if e["from"] == "minishop/checkout-api" and e["to"] == "minishop/payment-api")
    assert edge["healthy"] and edge["error_rate"] == 1 and edge["refused_rate"] == 0
    assert edge["latency_ms"] == 37.5


def test_explicit_live_mode_never_falls_back_at_startup(monkeypatch):
    import main
    monkeypatch.setenv("KUBEVERSE_MODE", "live")
    monkeypatch.delenv("KUBEVERSE_CONTEXT", raising=False)
    monkeypatch.setattr(main, "load_dotenv", lambda *args: None)
    monkeypatch.setattr(main, "discover", lambda context: None)
    monkeypatch.setattr(main, "live", None)
    async def scenario():
        with pytest.raises(RuntimeError, match="Kubernetes context unavailable"):
            async with main.lifespan(main.app):
                pytest.fail("Unavailable live mode must fail startup")
    asyncio.run(scenario())


def test_slow_log_worker_does_not_block_freshness_publishing(monkeypatch):
    import main
    cluster = LiveCluster("test")
    cluster.telemetry = setup_engine()
    release, started = threading.Event(), threading.Event()
    def slow():
        started.set()
        release.wait(5)
        return []
    cluster.collect_logs = slow
    cluster.refresh_resources = lambda: []
    monkeypatch.setattr(main, "live", cluster)
    published = []
    async def broadcast(batch, metrics):
        published.append(metrics)
        if len(published) >= 2:
            raise asyncio.CancelledError()
    monkeypatch.setattr(main, "broadcast", broadcast)
    async def scenario():
        task = asyncio.create_task(main.loop())
        try:
            await task
        except asyncio.CancelledError:
            pass
        finally:
            release.set()
    asyncio.run(scenario())
    assert started.is_set() and len(published) == 2
