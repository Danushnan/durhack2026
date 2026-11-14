from datetime import datetime, timedelta, timezone

from sim import demo_cluster
from telemetry import SimulatedRequests, propagation_paths


def test_payments_failure_propagates_to_callers_in_order():
    sim = demo_cluster()
    for t in range(6):
        sim.tick(t)
    source = SimulatedRequests(sim)
    bucket = datetime(2026, 1, 1, tzinfo=timezone.utc)
    healthy = source.sample(bucket, 1)
    assert any(row[3] == "shop/payments" for row in healthy)
    assert all(not row[5] for row in healthy)

    assert sim.sabotage("shop", "payments", True)
    for t in range(6, 11):
        sim.tick(t)
    timeline = [{"service": service, "bucket": bucket, "error_rate": 0,
                 "first_failure": None, "first_direct_failure": None}
                for service in ("shop/payments", "shop/checkout", "shop/frontend")]
    for i, service in enumerate(("shop/payments", "shop/checkout", "shop/frontend")):
        now = bucket + timedelta(seconds=5 + i)
        failures = {row[3] for row in source.sample(now, 1) if row[5]}
        assert service in failures
        if i < 2:
            assert ("shop/checkout", "shop/frontend")[i] not in failures
        timeline.append({"service": service, "bucket": bucket + timedelta(seconds=5),
                         "error_rate": 1, "first_failure": now,
                         "first_direct_failure": now if i == 0 else None})

    paths = propagation_paths(timeline, sim.calls)
    assert paths[-1]["path"] == ["shop/payments", "shop/checkout", "shop/frontend"]
