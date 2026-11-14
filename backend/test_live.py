import json
from pathlib import Path

from live import declared_calls, MANIFESTS, outcome, parse_samples, summarize

MINISHOP = Path(__file__).resolve().parent.parent / "minishop"
SERVICES = ["minishop-web", "product-api", "cart-api", "checkout-api", "payment-api", "postgres", "redis"]
BUILDINGS = {f"minishop/{s}" for s in SERVICES}


def test_outcomes_across_the_three_workload_log_shapes():
    cases = [
        ({"status": 200}, "ok"),
        # k8s/workload.py: a plain 503 is "nobody answered"; other codes are answers
        ({"status": 503}, "refused"), ({"status": 500}, "error"),
        # demo/workload.py: 504 unreachable, 502 = answered but a dependency failed
        ({"status": 504}, "refused"), ({"status": 502}, "error"),
        # MiniShop: payment declines are answers, connection failures are not
        ({"event": "http_client", "status": 402, "error": "HTTP 402"}, "error"),
        ({"event": "http_client", "status": 503, "error": "HTTP 503"}, "error"),
        ({"event": "http_client", "status": 503, "error": "ConnectError"}, "refused"),
        ({"event": "dependency", "status": 503, "error": "OperationalError"}, "refused"),
        ({"event": "http_server", "status": 500, "error": "RuntimeError"}, "error"),  # the service itself answered 500
    ]
    for sample, expected in cases:
        assert outcome(sample) == expected, sample


def test_minishop_topology_is_complete_with_no_traffic():
    assert MINISHOP / "architecture.json" in MANIFESTS
    edges = summarize([], BUILDINGS, declared_calls([]), now_ms=0)
    assert len(edges) == 10 and all(e["rps"] == 0 and e["healthy"] and e["latency_ms"] is None for e in edges)


def test_real_minishop_pod_logs_become_measured_edges():
    lines = (MINISHOP / "docs/kubernetes-checkout-events.jsonl").read_text()
    samples = parse_samples(lines, "minishop")
    now = max(s["at"] for s in samples)
    edges = {(e["from"], e["to"]): e for e in summarize(samples, BUILDINGS, declared_calls([]), now)}
    web_cart = edges[("minishop/minishop-web", "minishop/cart-api")]
    assert web_cart["requests"] == 4 and web_cart["error_rate"] == 0 and web_cart["latency_ms"] > 0
    # orders.transaction spans the whole checkout, so it must not count as PostgreSQL latency
    raw = [json.loads(l) for l in lines.splitlines() if '"orders.transaction"' in l]
    pg = edges[("minishop/checkout-api", "minishop/postgres")]
    assert raw and (pg["latency_ms"] is None or pg["latency_ms"] < max(r["latency_ms"] for r in raw))


def test_env_declared_calls_and_rates():
    deployment = {"kind": "Deployment", "metadata": {"namespace": "shop", "name": "cart"},
                  "spec": {"template": {"spec": {"containers": [{"env": [
                      {"name": "CALLS", "value": '[["redis.data", 2.5], ["payments", 1]]'}]}]}}}}
    assert {("shop/cart", "data/redis"), ("shop/cart", "shop/payments")} <= declared_calls([deployment])
    samples = [{"from": "a/x", "to": "a/y", "at": 1000, "outcome": o, "latency": 10.0} for o in ("ok", "ok", "error", "refused")]
    [e] = summarize(samples, {"a/x", "a/y"}, set(), 1000)
    assert (e["error_rate"], e["refused_rate"], e["healthy"], e["rps"]) == (0.25, 0.25, True, 0.8)
