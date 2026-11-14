"""Simulated Cluster: a tiny Kubernetes-like reconciler.

Pure module: no asyncio, no clock. Call tick(now) and read the watch events it returns.
Objects are serialised in (trimmed) Kubernetes shapes so a real cluster can replace this later.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
import itertools

POD_START_SECONDS = 1.5      # Pending(scheduled) -> Running
CRASH_AFTER_SECONDS = 1.0    # how long a Sabotaged container runs before it dies
TERMINATE_SECONDS = 1.0      # graceful deletion
# shortcut: real CrashLoopBackOff grows 10s -> 5min; compressed to 1s -> 8s so a demo can watch it.
BACKOFF_CAP_SECONDS = 8.0
MAX_REPLICAS = 10


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


@dataclass
class Node:
    name: str
    capacity: int
    ready: bool = True


@dataclass
class Deployment:
    namespace: str
    name: str
    replicas: int
    sabotaged: bool = False
    uid: str = ""


@dataclass
class Pod:
    namespace: str
    deployment: str
    name: str
    uid: str
    created: float
    node: str | None = None
    # container state: None (not started) | "ContainerCreating" | "running" | "CrashLoopBackOff"
    state: str | None = None
    ready: bool = False
    restarts: int = 0
    next_at: float = 0.0          # when the current state transitions
    backoff: float = 0.0
    deleting_at: float | None = None


@dataclass
class Simulator:
    nodes: dict[str, Node] = field(default_factory=dict)
    deployments: dict[str, Deployment] = field(default_factory=dict)  # key "ns/name"
    services: dict[str, str] = field(default_factory=dict)            # "ns/name" -> app label
    calls: list[tuple[str, str, float]] = field(default_factory=list)  # (from dep key, to svc key, base rps)
    pods: dict[str, Pod] = field(default_factory=dict)                 # uid -> Pod
    events: list[dict] = field(default_factory=list)
    _ids: itertools.count = field(default_factory=lambda: itertools.count(1))
    _last: dict[str, dict] = field(default_factory=dict)              # last serialised snapshot
    _last_traffic: list | None = None
    now: float = 0.0

    # ---------- setup ----------
    def add_node(self, name, capacity):
        self.nodes[name] = Node(name, capacity)

    def add_deployment(self, ns, name, replicas, calls=()):
        key = f"{ns}/{name}"
        self.deployments[key] = Deployment(ns, name, replicas, uid=f"dep-{next(self._ids)}")
        self.services[key] = name
        for target, rps in calls:
            self.calls.append((key, target, rps))

    # ---------- user actions (the write API) ----------
    def delete_pod(self, ns, name) -> bool:
        pod = next((p for p in self.pods.values() if p.namespace == ns and p.name == name), None)
        if not pod:
            return False
        self._terminate(pod, "Killing", f"Stopping container in pod {name} (user Demolish)")
        return True

    def scale(self, ns, name, replicas) -> bool:
        dep = self.deployments.get(f"{ns}/{name}")
        if not dep:
            return False
        dep.replicas = max(0, min(MAX_REPLICAS, replicas))
        self._event(dep, "Deployment", "ScalingReplicaSet", f"Scaled {name} to {dep.replicas}")
        return True

    def sabotage(self, ns, name, enabled) -> bool:
        dep = self.deployments.get(f"{ns}/{name}")
        if not dep:
            return False
        dep.sabotaged = enabled
        self._event(dep, "Deployment", "Sabotaged" if enabled else "Repaired",
                    f"{name}: containers will {'crash on start' if enabled else 'start normally'}",
                    warning=enabled)
        return True

    def set_node_outage(self, name, enabled) -> bool:
        node = self.nodes.get(name)
        if not node:
            return False
        node.ready = not enabled
        if enabled:
            self._node_event(name, "NodeNotReady", f"Node {name} status is now: NodeNotReady", True)
            # shortcut: real eviction waits ~5 min (tolerationSeconds); here it is immediate.
            for pod in list(self.pods.values()):
                if pod.node == name and pod.deleting_at is None:
                    self._terminate(pod, "TaintManagerEviction", f"Evicting pod {pod.name} from {name}", True)
        else:
            self._node_event(name, "NodeReady", f"Node {name} status is now: NodeReady", False)
        return True

    # ---------- the control loop ----------
    def tick(self, now: float) -> list[dict]:
        self.now = now
        for pod in list(self.pods.values()):
            self._step_pod(pod)
        for dep in self.deployments.values():
            self._reconcile(dep)
        self._schedule()
        return self._diff()

    def _step_pod(self, pod: Pod):
        dep = self.deployments[f"{pod.namespace}/{pod.deployment}"]
        if pod.deleting_at is not None:
            if self.now >= pod.deleting_at:
                del self.pods[pod.uid]
            return
        if pod.node is None or self.now < pod.next_at:
            return
        if pod.state in ("ContainerCreating", "CrashLoopBackOff"):
            if pod.state == "ContainerCreating":
                self._event_pod(pod, "Started", "Started container app")
            else:
                self._event_pod(pod, "Started", f"Restarted container app (restart #{pod.restarts})")
            pod.state, pod.ready = "running", not dep.sabotaged
            pod.next_at = self.now + CRASH_AFTER_SECONDS
        elif pod.state == "running" and dep.sabotaged:
            pod.restarts += 1
            backoff = min(2 ** (pod.restarts - 1), BACKOFF_CAP_SECONDS)
            pod.state, pod.ready, pod.next_at, pod.backoff = "CrashLoopBackOff", False, self.now + backoff, backoff
            self._event_pod(pod, "BackOff", f"Back-off {backoff:.0f}s restarting failed container app", True)
        elif pod.state == "running" and not pod.ready:
            pod.ready = True  # repaired while running

    def _reconcile(self, dep: Deployment):
        live = [p for p in self.pods.values()
                if p.namespace == dep.namespace and p.deployment == dep.name and p.deleting_at is None]
        for _ in range(dep.replicas - len(live)):
            uid = f"pod-{next(self._ids)}"
            pod = Pod(dep.namespace, dep.name, f"{dep.name}-{uid[4:]:0>5}", uid, self.now)
            self.pods[uid] = pod
            self._event(dep, "ReplicaSet", "SuccessfulCreate", f"Created pod: {pod.name}")
        if len(live) > dep.replicas:
            # Kubernetes prefers removing unscheduled, then not-ready, then newest pods.
            live.sort(key=lambda p: (p.node is not None, p.ready, -p.created))
            for pod in live[: len(live) - dep.replicas]:
                self._terminate(pod, "Killing", f"Stopping container in pod {pod.name} (scale down)")

    def _schedule(self):
        for pod in sorted(self.pods.values(), key=lambda p: p.created):
            if pod.node is not None or pod.deleting_at is not None:
                continue
            load = {n: 0 for n, node in self.nodes.items() if node.ready}
            for p in self.pods.values():
                if p.node in load:
                    load[p.node] += 1
            free = [n for n in load if load[n] < self.nodes[n].capacity]
            if not free:
                if pod.state != "Unschedulable":
                    pod.state = "Unschedulable"
                    self._event_pod(pod, "FailedScheduling",
                                    "0/%d nodes are available: insufficient capacity" % len(self.nodes), True)
                continue
            pod.node = min(free, key=lambda n: (load[n], n))
            pod.state, pod.next_at = "ContainerCreating", self.now + POD_START_SECONDS
            self._event_pod(pod, "Scheduled", f"Successfully assigned {pod.namespace}/{pod.name} to {pod.node}")

    def _terminate(self, pod, reason, message, warning=False):
        if pod.deleting_at is None:
            pod.deleting_at, pod.ready = self.now + TERMINATE_SECONDS, False
            self._event_pod(pod, reason, message, warning)

    # ---------- events ----------
    def _event(self, obj, kind, reason, message, warning=False):
        self._push(kind, obj.namespace, obj.name, reason, message, warning)

    def _event_pod(self, pod, reason, message, warning=False):
        self._push("Pod", pod.namespace, pod.name, reason, message, warning)

    def _node_event(self, name, reason, message, warning):
        self._push("Node", "", name, reason, message, warning)

    def _push(self, kind, ns, name, reason, message, warning):
        n = next(self._ids)
        self.events.append({
            "kind": "Event",
            "metadata": {"name": f"ev-{n}", "namespace": ns or "default", "uid": f"ev-{n}"},
            "involvedObject": {"kind": kind, "namespace": ns, "name": name},
            "reason": reason, "message": message,
            "type": "Warning" if warning else "Normal",
            "lastTimestamp": iso(self.now),
        })
        del self.events[:-60]

    # ---------- serialisation ----------
    def snapshot(self) -> dict[str, dict]:
        objs = []
        namespaces = sorted({d.namespace for d in self.deployments.values()})
        objs += [{"kind": "Namespace", "metadata": {"name": ns, "uid": f"ns-{ns}"}} for ns in namespaces]
        for n in self.nodes.values():
            objs.append({
                "kind": "Node", "metadata": {"name": n.name, "uid": f"node-{n.name}"},
                "status": {"capacity": {"pods": str(n.capacity)},
                           "conditions": [{"type": "Ready", "status": "True" if n.ready else "False"}]},
            })
        for key, d in self.deployments.items():
            pods = [p for p in self.pods.values() if p.namespace == d.namespace and p.deployment == d.name]
            meta = {"name": d.name, "namespace": d.namespace, "uid": d.uid}
            if d.sabotaged:
                meta["annotations"] = {"kubeverse.io/sabotaged": "true"}
            objs.append({
                "kind": "Deployment", "metadata": meta,
                "spec": {"replicas": d.replicas, "selector": {"matchLabels": {"app": d.name}}},
                "status": {"replicas": len(pods), "readyReplicas": sum(p.ready for p in pods)},
            })
            objs.append({
                "kind": "Service",
                "metadata": {"name": d.name, "namespace": d.namespace, "uid": f"svc-{d.uid}"},
                "spec": {"selector": {"app": self.services[key]}},
            })
        objs += [self._pod_json(p) for p in self.pods.values()]
        objs += self.events
        return {o["metadata"]["uid"]: o for o in objs}

    def _pod_json(self, p: Pod) -> dict:
        if p.state == "running":
            state = {"running": {}}
        elif p.state == "CrashLoopBackOff":
            state = {"waiting": {"reason": p.state, "message":
                                 f"back-off {p.backoff:.0f}s restarting failed container=app pod={p.name}"}}
        elif p.state == "ContainerCreating":
            state = {"waiting": {"reason": p.state}}
        else:
            state = {"waiting": {"reason": "Pending"}}
        meta = {"name": p.name, "namespace": p.namespace, "uid": p.uid, "labels": {"app": p.deployment},
                "creationTimestamp": iso(p.created)}
        if p.deleting_at is not None:
            meta["deletionTimestamp"] = iso(p.deleting_at)
        return {
            "kind": "Pod", "metadata": meta,
            "spec": {"nodeName": p.node},
            "status": {
                # Real phase semantics: CrashLoopBackOff pods are still phase Running.
                "phase": "Pending" if p.state in (None, "Unschedulable", "ContainerCreating") else "Running",
                "conditions": [{"type": "Ready", "status": "True" if p.ready else "False"}],
                "containerStatuses": [{"name": "app", "ready": p.ready, "restartCount": p.restarts,
                                       "state": state}],
            },
        }

    def traffic(self) -> list[dict]:
        def ready(key):
            d = self.deployments[key]
            return sum(p.ready for p in self.pods.values() if p.namespace == d.namespace and p.deployment == d.name)
        edges = []
        for src, dst, rps in self.calls:
            src_ready, dst_ready = ready(src), ready(dst)
            edges.append({"from": src, "to": dst, "rps": rps if src_ready else 0.0,
                          "healthy": dst_ready > 0})
        return edges

    def _diff(self) -> list[dict]:
        snap, out = self.snapshot(), []
        for uid, obj in snap.items():
            old = self._last.get(uid)
            if old is None:
                out.append({"type": "ADDED", "object": obj})
            elif old != obj:
                out.append({"type": "MODIFIED", "object": obj})
        out += [{"type": "DELETED", "object": o} for uid, o in self._last.items() if uid not in snap]
        self._last = snap
        traffic = self.traffic()
        if traffic != self._last_traffic:
            out.append({"type": "TRAFFIC", "edges": traffic})
            self._last_traffic = traffic
        return out

    def initial_events(self) -> list[dict]:
        """Everything a newly connected client needs: ADDED for every object, then traffic."""
        return [{"type": "ADDED", "object": o} for o in self._last.values()] + \
               [{"type": "TRAFFIC", "edges": self._last_traffic or []}]


def demo_cluster() -> Simulator:
    sim = Simulator()
    for i in range(1, 4):
        sim.add_node(f"node-{i}", capacity=5)
    sim.add_deployment("shop", "frontend", 3, [("shop/cart", 6), ("shop/checkout", 3)])
    sim.add_deployment("shop", "cart", 2, [("data/redis", 5)])
    sim.add_deployment("shop", "checkout", 2, [("shop/payments", 2), ("data/postgres", 3)])
    sim.add_deployment("shop", "payments", 2)
    sim.add_deployment("data", "postgres", 1)
    sim.add_deployment("data", "redis", 1)
    return sim
