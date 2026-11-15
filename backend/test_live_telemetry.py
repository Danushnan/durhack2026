import asyncio
from collections import Counter
import json
from pathlib import Path

import pytest
from fastapi import WebSocketDisconnect

from live import LiveCluster
from live_telemetry import COMPONENTS, LiveTelemetry, iso, parse_log


NOW = 1_794_687_480.0
FIXTURE = Path(__file__).resolve().parents[1] / "minishop/docs/kubernetes-checkout-events.jsonl"


def pod(name="payment-api", uid="pod-1", ready=True):
    return {"uid": uid, "name": f"{name}-{uid}", "namespace": "minishop", "deployment": name,
            "service": f"minishop/{name}", "ready": ready, "restarts": 0}


def record(stamp=NOW - 1, latency=100, status=200, rid="same-correlation-id", **fields):
    return {"timestamp_ms": int(stamp * 1000), "service": "payment-api", "event": "http_server",
            "request_id": rid, "method": "POST", "route": "/payments", "status": status,
            "source_service": "checkout-api", "latency_ms": latency, **fields}


def parse(data, p=None):
    p = p or pod()
    return parse_log(json.dumps(data), namespace=p["namespace"], deployment=p["deployment"],
                     pod_uid=p["uid"], pod=p["name"])


def setup_engine(pods=None, now=NOW, **settings):
    engine = LiveTelemetry("kind-minishop", **settings)
    pods = pods or [pod()]
    resources = {f"minishop/{name}": {"kind": "Deployment", "metadata": {"uid": f"dep-{name}",
                 "namespace": "minishop", "name": name}, "spec": {"replicas": sum(p["deployment"] == name for p in pods)}}
                 for name in COMPONENTS}
    engine.set_resources(resources, pods, now)
    for p in pods:
        engine.poll_result(p["uid"], now, since=now - 12)
    return engine


def metric(engine, name="payment-api", now=NOW):
    return next(s for s in engine.snapshot(now)["services"] if s["service"] == f"minishop/{name}")


def traffic(engine, buildings, now):
    cluster = LiveCluster("test")
    cluster.telemetry = engine
    cluster.objects = {key: {"kind": "Deployment", "metadata": dict(zip(("namespace", "name"), key.split("/")))}
                       for key in buildings}
    return cluster.traffic(now)


def test_measured_counts_latency_percentile_rejections_and_server_errors():
    engine = setup_engine()
    engine.ingest([parse(record(NOW - i - 1, latency, status))
                   for i, (latency, status) in enumerate(((100, 200), (200, 200), (300, 402), (400, 503)))], NOW)
    result = metric(engine)
    assert (result["request_count"], result["requests_per_second"]) == (4, .4)
    assert (result["avg_latency_ms"], result["p95_latency_ms"]) == (250, 400)
    assert (result["error_count"], result["error_rate"]) == (1, .25)
    assert (result["business_rejection_count"], result["business_decline_count"]) == (1, 1)
    assert result["infrastructure_status"] == "healthy"
    assert result["application_status"] == "degraded"


def test_declines_are_not_service_or_infrastructure_failures():
    engine = setup_engine()
    engine.ingest([parse(record(status=402))], NOW)
    result = metric(engine)
    assert result["error_count"] == 0 and result["error_rate"] == 0
    assert result["business_decline_count"] == 1
    assert result["application_status"] == result["infrastructure_status"] == "healthy"


def test_overlap_deduplicates_but_shared_request_ids_and_replicas_do_not():
    p1, p2 = pod(uid="one"), pod(uid="two")
    engine = setup_engine([p1, p2])
    lines = "\n".join(json.dumps(record(NOW - i, 100 + i)) for i in (1, 2))
    delivered = []
    unsubscribe = engine.subscribe(delivered.append)
    assert len(engine.ingest_logs(lines, p1, NOW)) == 2
    assert engine.ingest_logs(lines, p1, NOW) == ()
    assert len(engine.ingest_logs(lines, p2, NOW)) == 2
    assert metric(engine)["request_count"] == 4
    assert sum(map(len, delivered)) == 4
    unsubscribe()
    engine.ingest([parse(record(NOW - 3))], NOW)
    assert sum(map(len, delivered)) == 4


def test_identical_occurrences_preserved_and_replays_not_counted_twice():
    engine = setup_engine()
    line = json.dumps(record())
    assert len(engine.ingest_logs(line + "\n" + line, pod(), NOW)) == 2
    assert engine.ingest_logs(line + "\n" + line, pod(), NOW) == ()
    assert metric(engine)["request_count"] == 2


@pytest.mark.parametrize("update", [
    {"latency_ms": -1}, {"latency_ms": float("nan")}, {"latency_ms": float("inf")},
    {"status": "200"}, {"status": True}, {"status": 600}, {"method": None},
    {"timestamp_ms": None}, {"route": None}, {"request_id": []},
    {"event": "http_client", "target": None, "source": "payment-api"},
])
def test_malformed_measurements_are_ignored(update):
    assert parse(record(**update)) is None


@pytest.mark.parametrize("line", ["null", "[]", "{", "nginx startup message", "2026-11-14 invalid"])
def test_unstructured_and_invalid_json_do_not_crash(line):
    assert parse_log(line, namespace="minishop", deployment="payment-api", pod_uid="p", pod="p") is None


def test_probe_exclusion_and_proxy_runtime_timestamp_conversion():
    assert parse(record(route="/health/ready")) is None
    data = {"event": "proxy_access", "service": "minishop-web", "request_id": "id", "method": "GET",
            "route": "/api/products", "status": 200, "duration_seconds": .123, "upstream": "10.0.0.1:8000"}
    p = pod("minishop-web")
    assert parse(data, p) is None
    row = parse_log(f"{iso(NOW - 1)} {json.dumps(data)}", namespace="minishop", deployment=p["deployment"],
                    pod_uid=p["uid"], pod=p["name"])
    assert row.latency_ms == 123 and row.observed_at == NOW - 1
    data["duration_seconds"] = 1e308
    assert parse_log(f"{iso(NOW - 1)} {json.dumps(data)}", namespace="minishop", deployment=p["deployment"],
                     pod_uid=p["uid"], pod=p["name"]) is None


def test_window_boundaries_out_of_order_and_future_events():
    engine = setup_engine()
    engine.ingest([parse(record(t, latency)) for t, latency in (
        (NOW - 1, 100), (NOW - 10, 200), (NOW - 5, 300), (NOW + 20, 900))], NOW)
    result = metric(engine)
    assert result["request_count"] == 2 and result["avg_latency_ms"] == 200
    assert engine.rejected_records == 1
    engine.poll_result("pod-1", NOW + 11, since=NOW - 2)
    idle = metric(engine, now=NOW + 11)
    assert idle["availability"] == "idle" and idle["request_count"] == 0
    assert idle["avg_latency_ms"] is None and idle["error_rate"] is None
    assert idle["application_status"] == "unknown"


def test_checkout_outcomes_are_separate_from_service_errors():
    p = pod("checkout-api")
    engine = setup_engine([p])
    rows = [parse(record(NOW - i - 1, service="checkout-api", route="/checkout/session", status=s), p)
            for i, s in enumerate((200, 402, 503))]
    # Reading orders is an incoming request, but not a checkout attempt.
    rows.append(parse(record(NOW - 4, service="checkout-api", method="GET", route="/orders/session"), p))
    engine.ingest(rows, NOW)
    result = metric(engine, "checkout-api")
    assert result["request_count"] == 4 and result["error_count"] == 1
    assert result["checkout"] == {"attempt_count": 3, "success_count": 1, "business_rejection_count": 1,
                                   "failure_count": 1, "success_rate": 1 / 3}


def test_stored_genuine_logs_reach_metrics_and_existing_edges_once():
    records = [json.loads(line) for line in FIXTURE.read_text().splitlines()]
    now = max(r["timestamp_ms"] for r in records if "timestamp_ms" in r) / 1000 + .1
    pods = [pod(name, uid=name) for name in COMPONENTS]
    engine = setup_engine(pods, now=now)
    for p in pods:
        logs = "\n".join(json.dumps(r) for r in records if r["service"] == p["deployment"])
        engine.ingest_logs(logs, p, now)
        assert engine.ingest_logs(logs, p, now) == ()
    counts = Counter(r["service"] for r in records if r["event"] == "http_server")
    for name, count in counts.items():
        assert metric(engine, name, now)["request_count"] == count
    assert metric(engine, "payment-api", now)["avg_latency_ms"] == 101.48
    edges = traffic(engine, {f"minishop/{name}" for name in COMPONENTS}, now)
    assert len(edges) == 10
    assert any(e["from"] == "minishop/checkout-api" and e["to"] == "minishop/payment-api" for e in edges)
    assert metric(engine, "postgres", now)["request_count"] is None


class Socket:
    def __init__(self, telemetry=False):
        self.query_params = {"telemetry": "1"} if telemetry else {}
        self.messages = []
        self.ready, self.close = asyncio.Event(), asyncio.Event()

    async def accept(self):
        pass

    async def send_json(self, message):
        self.messages.append(message)
        self.ready.set()

    async def receive_text(self):
        await self.close.wait()
        raise WebSocketDisconnect()


def test_genuine_fixture_to_opt_in_socket_initial_snapshot_and_replacements(monkeypatch):
    import main
    records = [json.loads(line) for line in FIXTURE.read_text().splitlines()]
    payment = next(r for r in records if r["service"] == "payment-api" and r["event"] == "http_server")
    now = payment["timestamp_ms"] / 1000 + .1
    cluster = LiveCluster("fixture-context")
    cluster.telemetry = setup_engine(now=now)
    cluster.telemetry.ingest_logs(json.dumps(payment), pod(), now)
    monkeypatch.setattr(main, "live", cluster)
    monkeypatch.setattr(main.time, "time", lambda: now)
    async def scenario():
        plain, subscribed = Socket(), Socket(True)
        tasks = [asyncio.create_task(main.watch(ws)) for ws in (plain, subscribed)]
        await asyncio.gather(plain.ready.wait(), subscribed.ready.wait())
        assert all(e["type"] != "SERVICE_METRICS" for e in plain.messages[0])
        initial = next(e for e in subscribed.messages[0] if e["type"] == "SERVICE_METRICS")
        row = next(s for s in initial["services"] if s["service"] == "minishop/payment-api")
        assert row["request_count"] == 1 and row["avg_latency_ms"] == 101.48
        resource_event = {"type": "ADDED", "object": {"kind": "Deployment", "metadata": {"uid": "dep"}}}
        await main.broadcast([resource_event], cluster.telemetry.snapshot(now))
        assert plain.messages[-1] == [resource_event]
        assert subscribed.messages[-1][0] == resource_event
        assert subscribed.messages[-1][1] == initial
        for ws in (plain, subscribed):
            ws.close.set()
        await asyncio.gather(*tasks)
        assert not main.clients and not main.telemetry_clients and not main.send_locks
    asyncio.run(scenario())


def test_simulator_socket_compatibility(monkeypatch):
    import main
    monkeypatch.setattr(main, "live", None)
    main.sim.tick(NOW)
    async def scenario():
        ws = Socket(True)
        task = asyncio.create_task(main.watch(ws))
        await ws.ready.wait()
        assert ws.messages[0] == main.sim.initial_events()
        assert ws.messages[0][0] == {"type": "SOURCE", "context": None}
        ws.close.set()
        await task
    asyncio.run(scenario())


def test_subscriber_failure_isolated_and_not_redelivered(caplog):
    engine = setup_engine()
    def broken(batch):
        raise RuntimeError("consumer unavailable")
    delivered = []
    engine.subscribe(broken)
    engine.subscribe(delivered.append)
    row = parse(record())
    engine.ingest([row], NOW)
    assert engine.ingest([row], NOW) == ()
    assert len(delivered) == 1 and "subscriber failed" in caplog.text


def test_malformed_measurements_make_window_partial_instead_of_false_idle():
    engine = setup_engine()
    engine.ingest_logs(json.dumps(record(latency_ms=None)), pod(), NOW)
    result = metric(engine)
    assert result["availability"] == "partial" and result["request_count"] is None
    assert engine.snapshot(NOW)["source"]["rejected_records"] == 1
    assert "Invalid measurement" in engine.snapshot(NOW)["source"]["error"]


def test_last_event_survives_idle_buffer_expiry():
    engine = setup_engine()
    engine.ingest([parse(record())], NOW)
    later = NOW + engine.retention + 1
    engine.set_resources(engine._resources, [pod()], later)
    engine.poll_result("pod-1", later, since=later - 12)
    result = metric(engine, now=later)
    assert result["availability"] == "idle" and result["last_event_at"] == iso(NOW - 1)
    assert engine.snapshot(later)["source"]["last_application_event_at"] == iso(NOW - 1)


def test_documented_schema_matches_all_snapshot_fields():
    engine = setup_engine([pod("checkout-api")])
    p = pod("checkout-api")
    engine.ingest([parse(record(service="checkout-api", route="/checkout/session"), p)], NOW)
    event = engine.snapshot(NOW)
    schema = json.loads(Path(__file__).with_name("service_metrics.schema.json").read_text())
    def fields(value, definition):
        assert set(value) == set(definition["required"]) == set(definition["properties"])
    fields(event, schema)
    fields(event["window"], schema["properties"]["window"])
    fields(event["source"], schema["properties"]["source"])
    row_schema = schema["properties"]["services"]["items"]
    assert len(event["services"]) == 7
    for row in event["services"]:
        fields(row, row_schema)
        for key in ("availability", "application_status", "infrastructure_status", "measurement_kind"):
            assert row[key] in row_schema["properties"][key]["enum"]
        if row["checkout"] is not None:
            fields(row["checkout"], row_schema["properties"]["checkout"]["anyOf"][0])
    json.dumps(event, allow_nan=False)


def test_measured_latency_degradation_and_recovery():
    engine = setup_engine()
    engine.ingest([parse(record(latency=2000))], NOW)
    slow = metric(engine)
    assert slow["application_status"] == "degraded" and slow["error_count"] == 0
    assert slow["infrastructure_status"] == "healthy"
    later = NOW + 11
    engine.set_resources(engine._resources, [pod()], later)
    engine.poll_result("pod-1", later, since=NOW - 2)
    engine.ingest([parse(record(later - 1, latency=100))], later)
    recovered = metric(engine, now=later)
    assert recovered["application_status"] == "healthy" and recovered["avg_latency_ms"] == 100


def test_outgoing_failure_is_not_a_fabricated_incoming_request():
    engine = setup_engine()
    data = record(service="checkout-api", event="http_client", source="checkout-api",
                  target="payment-api.minishop.svc.cluster.local", status=503, error="ConnectError")
    row = parse(data, pod("checkout-api"))
    delivered = engine.ingest([row], NOW)
    assert delivered[0].target == "minishop/payment-api" and delivered[0].error == "ConnectError"
    assert metric(engine)["request_count"] == 0
    [edge] = traffic(engine, {"minishop/checkout-api", "minishop/payment-api"}, NOW)
    assert (edge["from"], edge["to"], edge["rps"], edge["healthy"]) == (
        "minishop/checkout-api", "minishop/payment-api", .2, False)
    assert edge["requests"] == 1 and edge["refused_rate"] == 1 and edge["error_rate"] == 0


def test_generic_demo_edge_format_is_preserved():
    row = parse_log(json.dumps({"source": "gateway", "target": "payments.demo.svc.cluster.local",
                    "timestamp_ms": int((NOW - 1) * 1000), "status": 200, "duration_ms": 18,
                    "trace_id": "trace", "source_pod": "gateway-1"}), namespace="demo", deployment="gateway",
                    pod_uid="generic", pod="gateway-1", application="kubeverse-demo")
    engine = setup_engine()
    assert row.request_id == "trace" and row.latency_ms == 18
    engine.ingest([row], NOW)
    [edge] = traffic(engine, {"demo/gateway", "demo/payments"}, NOW)
    assert (edge["from"], edge["to"], edge["rps"], edge["healthy"]) == ("demo/gateway", "demo/payments", .2, True)
    assert edge["requests"] == 1 and edge["latency_ms"] == 18


def test_other_demo_sources_do_not_refresh_minishop_log_freshness():
    p = pod("gateway")
    p["namespace"], p["service"] = "other-demo", "other-demo/gateway"
    engine = setup_engine([p])
    snapshot = engine.snapshot(NOW)
    assert snapshot["source"]["last_log_poll_at"] is None
    assert snapshot["source"]["last_application_event_at"] is None


def test_pod_unavailability_and_stale_resources_are_independent_of_response_codes():
    engine = setup_engine([pod(ready=False)])
    result = metric(engine)
    assert result["infrastructure_status"] == result["application_status"] == "unavailable"
    assert metric(engine, now=NOW + 11)["infrastructure_status"] == "unknown"


@pytest.mark.parametrize("settings", [
    {"window_seconds": 0}, {"stale_seconds": -1}, {"error_threshold": 2},
    {"latency_threshold_ms": float("inf")},
])
def test_invalid_settings_fail_clearly(settings):
    with pytest.raises(ValueError):
        LiveTelemetry("test", **settings)
