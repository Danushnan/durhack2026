from sim import demo_cluster


def run(sim, start, seconds, step=0.5):
    t = start
    while t < start + seconds:
        sim.tick(t)
        t += step
    return t


def pods(sim, dep):
    return [p for p in sim.pods.values() if p.deployment == dep and p.deleting_at is None]


def ready(sim, dep):
    return sum(p.ready for p in sim.pods.values() if p.deployment == dep)


def test_cluster_converges():
    sim = demo_cluster()
    run(sim, 0, 5)
    assert ready(sim, "frontend") == 3 and ready(sim, "redis") == 1


def test_demolish_heals_with_new_pod():
    sim = demo_cluster()
    t = run(sim, 0, 5)
    victim = pods(sim, "cart")[0]
    assert sim.delete_pod("shop", victim.name)
    t = run(sim, t, 5)
    names = {p.name for p in pods(sim, "cart")}
    assert victim.name not in names and len(names) == 2 and ready(sim, "cart") == 2


def test_scale_up_and_down():
    sim = demo_cluster()
    t = run(sim, 0, 5)
    sim.scale("shop", "payments", 4)
    t = run(sim, t, 5)
    assert ready(sim, "payments") == 4
    sim.scale("shop", "payments", 1)
    run(sim, t, 3)
    assert len([p for p in sim.pods.values() if p.deployment == "payments"]) == 1


def test_sabotage_crashloops_then_repair_recovers():
    sim = demo_cluster()
    t = run(sim, 0, 5)
    sim.sabotage("shop", "payments", True)
    t = run(sim, t, 10)
    assert ready(sim, "payments") == 0
    assert all(p.restarts >= 2 for p in pods(sim, "payments"))
    assert not next(e for e in sim.traffic() if e["to"] == "shop/payments")["healthy"]
    sim.sabotage("shop", "payments", False)
    run(sim, t, 12)
    assert ready(sim, "payments") == 2


def test_node_outage_reschedules_and_overflows_to_pending():
    sim = demo_cluster()  # 11 pods, 3 nodes x 5 capacity
    sim.scale("shop", "frontend", 7)  # 15 pods: exactly full
    t = run(sim, 0, 5)
    sim.set_node_outage("node-1", True)
    t = run(sim, t, 5)
    assert not any(p.node == "node-1" for p in sim.pods.values())
    assert sum(p.node is None for p in sim.pods.values()) == 5  # only 10 slots left
    sim.set_node_outage("node-1", False)
    run(sim, t, 5)
    assert all(p.ready for p in sim.pods.values())


def test_reconnect_snapshot_contains_everything():
    sim = demo_cluster()
    run(sim, 0, 3)
    kinds = {e["object"]["kind"] for e in sim.initial_events() if e["type"] == "ADDED"}
    assert {"Namespace", "Node", "Deployment", "Service", "Pod", "Event"} <= kinds
