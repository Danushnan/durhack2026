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
    t = run(sim, t, 7)
    names = {p.name for p in pods(sim, "cart")}
    assert victim.name not in names and len(names) == 2 and ready(sim, "cart") == 2


def test_scale_up_and_down():
    sim = demo_cluster()
    t = run(sim, 0, 5)
    sim.scale("shop", "payments", 4)
    t = run(sim, t, 7)
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
    run(sim, t, 14)
    assert ready(sim, "payments") == 2


def test_node_outage_reschedules_and_overflows_to_pending():
    sim = demo_cluster()  # 11 pods, 3 nodes x 6 capacity
    sim.deployments["shop/frontend"].hpa = None  # keep the autoscaler from undoing the manual scale
    sim.scale("shop", "frontend", 10)  # 18 pods: exactly full
    t = run(sim, 0, 5)
    sim.set_node_outage("node-1", True)
    t = run(sim, t, 5)
    # Its Pods are stuck Terminating (the dead Node cannot confirm they stopped); none still serve.
    assert all(p.deleting_at is not None and not p.ready for p in sim.pods.values() if p.node == "node-1")
    assert sum(p.node is None for p in sim.pods.values()) == 6  # 12 slots left, all taken
    sim.set_node_outage("node-1", False)
    run(sim, t, 7)
    assert all(p.ready for p in sim.pods.values())


def test_reconnect_snapshot_contains_everything():
    sim = demo_cluster()
    run(sim, 0, 3)
    kinds = {e["object"]["kind"] for e in sim.initial_events() if e["type"] == "ADDED"}
    assert {"Namespace", "Node", "Deployment", "StatefulSet", "Service", "Ingress", "Pod", "Event",
            "PersistentVolumeClaim", "PodDisruptionBudget", "HorizontalPodAutoscaler"} <= kinds


def test_new_pods_are_running_before_they_are_ready():
    sim = demo_cluster()
    t = run(sim, 0, 2.6)  # started (1.5s) but readiness (2s) not yet passed
    started = [p for p in sim.pods.values() if p.state == "running"]
    assert started and not any(p.ready for p in started)
    run(sim, t, 3)
    assert all(p.ready for p in sim.pods.values())


def test_rolling_update_keeps_the_service_up_and_finishes():
    sim = demo_cluster()
    t = run(sim, 0, 6)
    sim.release("shop", "payments")
    for _ in range(40):
        sim.tick(t)
        t += 0.5
        assert ready(sim, "payments") >= 2  # maxUnavailable 25% of 2 rounds down to 0
    assert {p.version for p in pods(sim, "payments")} == {"v2"} and ready(sim, "payments") == 2


def test_buggy_release_stalls_with_old_version_serving_then_rolls_back():
    sim = demo_cluster()
    t = run(sim, 0, 6)
    sim.release("shop", "payments", buggy=True)
    t = run(sim, t, 22)
    assert ready(sim, "payments") == 2
    assert {p.version for p in pods(sim, "payments") if p.ready} == {"v1"}
    assert any(p.version == "v2" and p.restarts > 0 for p in pods(sim, "payments"))
    assert any(e["reason"] == "ProgressDeadlineExceeded" for e in sim.events)
    assert next(e for e in sim.traffic() if e["to"] == "shop/payments")["healthy"]
    assert sim.rollback("shop", "payments")
    run(sim, t, 6)
    assert {p.version for p in pods(sim, "payments")} == {"v1"} and ready(sim, "payments") == 2


def test_rollback_needs_a_previous_version():
    assert not demo_cluster().rollback("shop", "payments")


def test_customers_enter_through_the_ingress():
    sim = demo_cluster()
    t = run(sim, 0, 6)
    gate = next(e for e in sim.traffic() if e["from"] == "ingress:shop/storefront")
    assert gate["to"] == "shop/frontend" and gate["healthy"]
    sim.sabotage("shop", "frontend", True)
    run(sim, t, 3)
    assert not next(e for e in sim.traffic() if e["from"].startswith("ingress:"))["healthy"]


def test_requests_to_an_impacted_service_return_errors():
    sim = demo_cluster()
    t = run(sim, 0, 6)
    sim.sabotage("shop", "payments", True)
    run(sim, t, 4)
    edges = {(e["from"], e["to"]): e for e in sim.traffic()}
    assert not edges[("shop/checkout", "shop/payments")]["healthy"]          # nobody to answer
    to_checkout = edges[("shop/frontend", "shop/checkout")]
    assert to_checkout["healthy"] and to_checkout["errors"]                  # answers, with an error
    assert not edges[("shop/frontend", "shop/cart")]["errors"]


def test_statefulset_keeps_its_name_and_data():
    sim = demo_cluster()
    t = run(sim, 0, 6)
    pg = pods(sim, "postgres")
    assert [p.name for p in pg] == ["postgres-0"] and pg[0].claim == "data-postgres-0"
    sim.delete_pod("data", "postgres-0")
    t = run(sim, t, 7)
    pg = pods(sim, "postgres")
    assert [p.name for p in pg] == ["postgres-0"] and pg[0].claim == "data-postgres-0" and pg[0].ready
    sim.scale("data", "postgres", 2)
    t = run(sim, t, 8)
    assert sorted(p.name for p in pods(sim, "postgres")) == ["postgres-0", "postgres-1"]
    sim.scale("data", "postgres", 1)
    run(sim, t, 3)
    assert [p.name for p in pods(sim, "postgres")] == ["postgres-0"]
    assert "data-postgres-1" in sim.claims  # scaling down keeps the volume


def test_statefulset_pod_on_a_dead_node_is_not_duplicated():
    sim = demo_cluster()
    t = run(sim, 0, 6)
    node = pods(sim, "postgres")[0].node
    sim.set_node_outage(node, True)
    t = run(sim, t, 8)
    pg = [p for p in sim.pods.values() if p.deployment == "postgres"]
    assert len(pg) == 1 and pg[0].deleting_at is not None and not pg[0].ready  # stuck Terminating, no twin
    sim.set_node_outage(node, False)
    run(sim, t, 8)
    assert ready(sim, "postgres") == 1


def test_drain_respects_disruption_budgets_and_empties_the_node():
    sim = demo_cluster()
    t = run(sim, 0, 6)
    node = pods(sim, "payments")[0].node
    sim.drain(node, True)
    for _ in range(40):
        sim.tick(t)
        t += 0.5
        assert ready(sim, "payments") >= 1  # maxUnavailable 1 of 2
    assert not any(p.node == node for p in sim.pods.values())
    assert sim.nodes[node].cordoned and not sim.nodes[node].draining
    sim.drain(node, False)
    assert not sim.nodes[node].cordoned


def test_rush_hour_autoscales_the_frontend_and_back():
    sim = demo_cluster()
    t = run(sim, 0, 6)
    assert sim.deployments["shop/frontend"].replicas == 3
    sim.rush_hour(True)
    t = run(sim, t, 15)
    grown = sim.deployments["shop/frontend"].replicas
    assert 3 < grown <= 7 and any(e["reason"] == "SuccessfulRescale" for e in sim.events)
    sim.rush_hour(False)
    run(sim, t, 30)
    assert sim.deployments["shop/frontend"].replicas == 3


def test_reset_restores_the_demo_without_reusing_ids():
    sim = demo_cluster()
    t = run(sim, 0, 6)
    before = set(sim.pods)
    sim.sabotage("shop", "payments", True)
    sim.drain("node-1", True)
    t = run(sim, t, 4)
    sim.reset()
    run(sim, t, 8)
    assert all(p.ready for p in sim.pods.values()) and not before & set(sim.pods)
    assert not any(n.cordoned for n in sim.nodes.values())


def snap(sim, kind):
    return [o for o in sim.snapshot().values() if o["kind"] == kind]


def test_deployments_own_replicasets_which_own_pods():
    sim = demo_cluster()
    t = run(sim, 0, 6)
    [rs1] = [r for r in snap(sim, "ReplicaSet") if r["metadata"]["ownerReferences"][0]["name"] == "payments"]
    assert rs1["spec"]["replicas"] == 2 and rs1["status"]["readyReplicas"] == 2
    owners = {p["metadata"]["ownerReferences"][0]["name"] for p in snap(sim, "Pod") if p["metadata"]["labels"]["app"] == "payments"}
    assert owners == {rs1["metadata"]["name"]}
    assert all(p.name.startswith(rs1["metadata"]["name"] + "-") for p in pods(sim, "payments"))
    sim.release("shop", "payments")
    t = run(sim, t, 20)
    by_version = {r["metadata"]["labels"]["version"]: r for r in snap(sim, "ReplicaSet") if r["metadata"]["labels"]["app"] == "payments"}
    assert by_version["v1"]["spec"]["replicas"] == 0 and by_version["v2"]["spec"]["replicas"] == 2  # old one kept for rollback
    sim.rollback("shop", "payments")
    run(sim, t, 20)
    assert {p.name.rsplit("-", 1)[0] for p in pods(sim, "payments")} == {rs1["metadata"]["name"]}  # same template, same ReplicaSet


def test_node_outage_waits_for_heartbeats_then_tolerations():
    sim = demo_cluster()
    t = run(sim, 0, 6)
    victims = {p.uid for p in sim.pods.values() if p.node == "node-2"}
    sim.set_node_outage("node-2", True)
    t = run(sim, t, 1)
    assert sim.nodes["node-2"].ready  # Kubernetes has not noticed yet
    t = run(sim, t, 1.5)
    [node] = [n for n in snap(sim, "Node") if n["metadata"]["name"] == "node-2"]
    assert node["spec"]["taints"][0]["key"] == "node.kubernetes.io/unreachable"
    assert all(not sim.pods[u].ready and sim.pods[u].deleting_at is None for u in victims)  # out of rotation, not yet evicted
    run(sim, t, 3)
    assert all(sim.pods[u].deleting_at is not None for u in victims)


def test_scheduler_spreads_replicas_and_assigns_ips():
    sim = demo_cluster()
    run(sim, 0, 6)
    assert len({p.node for p in pods(sim, "frontend")}) == 3
    [eps] = [e for e in snap(sim, "EndpointSlice") if e["metadata"]["labels"]["kubernetes.io/service-name"] == "frontend"]
    assert len(eps["endpoints"]) == 3 and all(e["conditions"]["ready"] and e["addresses"][0].startswith("10.244.") for e in eps["endpoints"])


def test_traffic_only_flows_where_requests_arrive():
    sim = demo_cluster()
    t = run(sim, 0, 6)
    rates = {(e["from"], e["to"]): e["rps"] for e in sim.traffic()}
    assert rates[("shop/cart", "data/redis")] == 5 and rates[("shop/frontend", "shop/cart")] == 6
    sim.sabotage("shop", "frontend", True)
    run(sim, t, 4)
    rates = {(e["from"], e["to"]): e["rps"] for e in sim.traffic()}
    assert rates[("shop/frontend", "shop/cart")] == 0 and rates[("shop/cart", "data/redis")] == 0  # no customers get past the frontend
