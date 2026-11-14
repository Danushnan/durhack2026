"""Simulated Cluster: a tiny Kubernetes-like reconciler.

Pure module: no asyncio, no clock. Call tick(now) and read the watch events it returns.
Objects are serialised in (trimmed) Kubernetes shapes so a real cluster can replace this later.
"""
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
import hashlib
import itertools
import math

POD_START_SECONDS = 1.5      # Pending(scheduled) -> Running
CRASH_AFTER_SECONDS = 1.0    # how long a Sabotaged container runs before it dies
TERMINATE_SECONDS = 1.0      # graceful deletion
# shortcut: stands in for a readiness probe; real apps configure their own probe timing.
READY_SECONDS = 2.0          # Running -> Ready (only then does the Service send it requests)
MAX_SURGE = 0.25             # rolling-update defaults: up to 25% extra Pods...
MAX_UNAVAILABLE = 0.25       # ...and at most 25% unavailable while replacing them
# shortcut: Kubernetes' default progressDeadlineSeconds is 600; compressed so a stalled rollout shows quickly.
PROGRESS_DEADLINE_SECONDS = 15.0
INGRESS_RPS = 8.0
RUSH_RPS = 24.0
RUSH_SECONDS = 45.0
# shortcut: the HPA syncs every 15s and waits 300s before scaling down by default; compressed for the demo.
HPA_SYNC_SECONDS = 3.0
HPA_DOWNSCALE_WINDOW_SECONDS = 20.0
# shortcut: real CrashLoopBackOff grows 10s -> 5min; compressed to 1s -> 8s so a demo can watch it.
BACKOFF_CAP_SECONDS = 8.0
MAX_REPLICAS = 10
POD_RPS = 4.0                # requests/second one Pod handles comfortably; beyond that requests queue
REFUSED_MS = 3.0             # a refused call fails fast: nothing even answered
# shortcut: node-monitor-grace-period is 40s and the default NoExecute toleration 300s; compressed for the demo.
NODE_GRACE_SECONDS = 1.5     # no kubelet heartbeat for this long -> the node controller marks the Node NotReady
TOLERATION_SECONDS = 2.0     # Pods tolerate an unreachable Node this long before they are evicted
NAME_ALPHABET = "bcdfghjklmnpqrstvwxz2456789"  # what Kubernetes uses for generated name suffixes

# Which part of Kubernetes reports each event (Event.reportingComponent).
COMPONENT = {
    "SuccessfulCreate": "replicaset-controller", "SuccessfulDelete": "replicaset-controller",
    "TaintManagerEviction": "taint-eviction-controller",
    "ScalingReplicaSet": "deployment-controller", "DeploymentRollback": "deployment-controller",
    "ProgressDeadlineExceeded": "deployment-controller",
    "Scheduled": "default-scheduler", "FailedScheduling": "default-scheduler",
    "Started": "kubelet", "BackOff": "kubelet", "Killing": "kubelet",
    "NodeNotSchedulable": "kubelet", "NodeSchedulable": "kubelet",
    "NodeNotReady": "node-controller", "NodeReady": "node-controller",
    "SuccessfulRescale": "horizontal-pod-autoscaler",
}


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


def suffix(seed: str, n: int) -> str:
    """A stable generated-name suffix, like the pod-template-hash in a ReplicaSet's name."""
    h, out = int(hashlib.sha256(seed.encode()).hexdigest(), 16), ""
    for _ in range(n):
        h, i = divmod(h, len(NAME_ALPHABET))
        out += NAME_ALPHABET[i]
    return out


@dataclass
class Node:
    name: str
    capacity: int
    index: int = 0                 # picks this Node's Pod IP range
    powered: bool = True           # its kubelet is alive and sending heartbeats
    heartbeat: float = 0.0
    ready: bool = True             # the Ready condition, as the node controller last judged it
    unreachable_since: float | None = None   # when the unreachable NoExecute taint was added
    cordoned: bool = False         # unschedulable: no new Pods (kubectl cordon / drain)
    draining: bool = False
    blocked: str = ""              # why the drain is waiting, if it is
    next_ip: int = 2


@dataclass
class Autoscaler:
    """A HorizontalPodAutoscaler on requests per second per ready Pod."""
    min: int
    max: int
    target_rps: float
    synced_at: float = -1e9
    recommendations: list = field(default_factory=list)   # (time, desired) for the scale-down window
    metric: float = 0.0
    desired: int = 0


@dataclass
class Deployment:
    """A workload: a Deployment, or a StatefulSet when kind says so."""
    namespace: str
    name: str
    replicas: int
    sabotaged: bool = False
    uid: str = ""
    kind: str = "Deployment"
    version: str = "v1"                               # the Pod template Kubernetes is rolling towards
    revision: int = 1
    buggy: set[str] = field(default_factory=set)      # versions whose containers crash on start
    history: list[str] = field(default_factory=lambda: ["v1"])
    progress_at: float = 0.0                          # last time the rollout moved forward
    progress_sig: tuple = ()
    stalled: bool = False
    max_unavailable: int | None = None                # PodDisruptionBudget, if any
    hpa: Autoscaler | None = None
    replica_sets: dict[str, int] = field(default_factory=dict)  # version -> desired replicas of its ReplicaSet
    latency_ms: float = 20.0                          # its own work per request, unloaded

    def rs_name(self, version):
        return f"{self.name}-{suffix(f'{self.namespace}/{self.name}/{version}', 10)}"


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
    version: str = "v1"
    claim: str | None = None      # StatefulSet Pods keep their PersistentVolumeClaim
    ip: str | None = None         # assigned when the Pod lands on a Node


@dataclass
class Ingress:
    namespace: str
    name: str
    host: str
    service: str      # "ns/name" of the Service it routes to


@dataclass
class Simulator:
    nodes: dict[str, Node] = field(default_factory=dict)
    deployments: dict[str, Deployment] = field(default_factory=dict)  # key "ns/name" (StatefulSets too)
    services: dict[str, str] = field(default_factory=dict)            # "ns/name" -> app label
    calls: list[tuple[str, str, float]] = field(default_factory=list)  # (from dep key, to svc key, base rps)
    pods: dict[str, Pod] = field(default_factory=dict)                 # uid -> Pod
    claims: dict[str, dict] = field(default_factory=dict)             # PVC name -> {namespace, app, created}
    ingresses: list[Ingress] = field(default_factory=list)
    events: list[dict] = field(default_factory=list)
    rush_until: float = 0.0
    _ids: itertools.count = field(default_factory=lambda: itertools.count(1))
    _last: dict[str, dict] = field(default_factory=dict)              # last serialised snapshot
    _last_traffic: list | None = None
    now: float = 0.0

    # ---------- setup ----------
    def add_node(self, name, capacity):
        self.nodes[name] = Node(name, capacity, index=len(self.nodes) + 1)

    def add_deployment(self, ns, name, replicas, calls=(), kind="Deployment", max_unavailable=None, hpa=None, latency_ms=20.0):
        key = f"{ns}/{name}"
        self.deployments[key] = Deployment(ns, name, replicas, uid=f"dep-{next(self._ids)}", kind=kind,
                                           max_unavailable=max_unavailable, hpa=hpa, latency_ms=latency_ms)
        self.services[key] = name
        for target, rps in calls:
            self.calls.append((key, target, rps))

    def add_ingress(self, ns, name, host, service):
        self.ingresses.append(Ingress(ns, name, host, service))

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
        dep.replicas = max(0, min(MAX_REPLICAS, replicas))  # the Deployment controller scales its ReplicaSet
        return True

    def sabotage(self, ns, name, enabled) -> bool:
        dep = self.deployments.get(f"{ns}/{name}")
        if not dep:
            return False
        dep.sabotaged = enabled
        self._event(dep, "Sabotaged" if enabled else "Repaired",
                    f"{name}: containers will {'crash on start' if enabled else 'start normally'}", warning=enabled)
        return True

    def release(self, ns, name, buggy=False) -> bool:
        """Change the Pod template to a new version: Kubernetes rolls it out gradually."""
        dep = self.deployments.get(f"{ns}/{name}")
        if not dep or dep.kind != "Deployment":
            return False
        latest = max(int(v[1:]) for v in dep.history)
        dep.version = f"v{latest + 1}"
        if buggy:
            dep.buggy.add(dep.version)
        self._new_revision(dep)
        return True

    def rollback(self, ns, name) -> bool:
        """Like `kubectl rollout undo`: go back to the previous version's Pod template."""
        dep = self.deployments.get(f"{ns}/{name}")
        previous = next((v for v in reversed(dep.history) if v != dep.version), None) if dep and dep.kind == "Deployment" else None
        if not previous:
            return False
        dep.version = previous
        self._new_revision(dep)
        self._event(dep, "DeploymentRollback", f"Rolled back deployment {name} to {previous}")
        return True

    def _new_revision(self, dep):
        dep.revision += 1
        dep.history.append(dep.version)
        dep.progress_at, dep.progress_sig, dep.stalled = self.now, (), False

    def set_node_outage(self, name, enabled) -> bool:
        """Cut or restore a Node's power. Kubernetes is not told: it notices when the heartbeats stop."""
        node = self.nodes.get(name)
        if not node:
            return False
        node.powered = not enabled
        return True

    def drain(self, name, enabled) -> bool:
        """`kubectl drain` (cordon, then evict Pods respecting disruption budgets) or `kubectl uncordon`."""
        node = self.nodes.get(name)
        if not node:
            return False
        node.cordoned, node.draining, node.blocked = enabled, enabled, ""
        self._node_event(name, "NodeNotSchedulable" if enabled else "NodeSchedulable",
                         f"Node {name} status is now: {'NodeNotSchedulable' if enabled else 'NodeSchedulable'}", False)
        return True

    def rush_hour(self, enabled) -> bool:
        self.rush_until = self.now + RUSH_SECONDS if enabled else 0.0
        return True

    def reset(self):
        """Back to the demo's starting state, in place (telemetry holds a reference to this object).
        Ids keep counting and the last snapshot is kept, so clients get proper DELETED/ADDED events."""
        fresh = demo_cluster()
        for attr in ("nodes", "deployments", "services", "calls", "claims", "ingresses"):
            setattr(self, attr, getattr(fresh, attr))
        self.pods, self.rush_until = {}, 0.0
        self._push("Namespace", "", "cluster", "Reset", "The demo city was reset to its starting state", False, "kuebec")
        return True

    # ---------- the control loop ----------
    def tick(self, now: float) -> list[dict]:
        self.now = now
        for pod in list(self.pods.values()):
            self._step_pod(pod)          # each kubelet runs its Node's Pods
        self._node_lifecycle()
        for dep in self.deployments.values():
            if dep.hpa:
                self._autoscale(dep)
            if dep.kind == "StatefulSet":
                self._reconcile_set(dep)
            else:
                self._reconcile(dep)     # the Deployment controller sizes ReplicaSets...
                for version in dep.replica_sets:
                    self._sync_rs(dep, version)  # ...and the ReplicaSet controller makes Pods match
        for node in self.nodes.values():
            if node.draining:
                self._drain_step(node)
        self._schedule()
        return self._diff()

    def _step_pod(self, pod: Pod):
        dep = self.deployments[f"{pod.namespace}/{pod.deployment}"]
        if pod.node is not None and not self.nodes[pod.node].powered:
            return  # its kubelet is dead: nothing on that Node changes, and nobody can confirm a deletion
        if pod.deleting_at is not None:
            if self.now >= pod.deleting_at:
                del self.pods[pod.uid]
            return
        if pod.node is None or self.now < pod.next_at:
            return
        crashes = dep.sabotaged or pod.version in dep.buggy
        if pod.state in ("ContainerCreating", "CrashLoopBackOff"):
            if pod.state == "ContainerCreating":
                self._event_pod(pod, "Started", "Started container app")
            else:
                self._event_pod(pod, "Started", f"Restarted container app (restart #{pod.restarts})")
            # Running is not Ready: the Pod gets no requests until its readiness check passes.
            pod.state, pod.ready = "running", False
            pod.next_at = self.now + (CRASH_AFTER_SECONDS if crashes else READY_SECONDS)
        elif pod.state == "running" and crashes:
            pod.restarts += 1
            backoff = min(2 ** (pod.restarts - 1), BACKOFF_CAP_SECONDS)
            pod.state, pod.ready, pod.next_at, pod.backoff = "CrashLoopBackOff", False, self.now + backoff, backoff
            self._event_pod(pod, "BackOff", f"Back-off {backoff:.0f}s restarting failed container app", True)
        elif pod.state == "running" and not pod.ready:
            pod.ready = True  # readiness check passed (or repaired while running)

    def _pods_of(self, dep, include_deleting=False):
        return [p for p in self.pods.values() if p.namespace == dep.namespace and p.deployment == dep.name
                and (include_deleting or p.deleting_at is None)]

    def _reconcile(self, dep: Deployment):
        """Deployment controller: one ReplicaSet per Pod template (version). Outside a rollout the current
        ReplicaSet is sized to the Deployment; during one, `_roll` moves replicas from old to new."""
        sets = dep.replica_sets
        sets.setdefault(dep.version, 0)
        olds = sorted((v for v in sets if v != dep.version and sets[v] > 0), key=lambda v: int(v[1:]))
        if olds:
            self._roll(dep, olds)
        elif sets[dep.version] != dep.replicas:
            self._scale_rs(dep, dep.version, dep.replicas)

    def _roll(self, dep, olds):
        """One step of a rolling update, as the Deployment controller does it: scale the new ReplicaSet up
        within maxSurge, then scale old ones down only while maxUnavailable allows. A new version that never
        becomes ready stalls here, with the old version still serving."""
        sets, new, r = dep.replica_sets, dep.version, dep.replicas
        surge = math.ceil(r * MAX_SURGE)
        min_available = r - math.floor(r * MAX_UNAVAILABLE)
        room = r + surge - sum(sets.values())
        if sets[new] < r and room > 0:
            self._scale_rs(dep, new, min(r, sets[new] + room))
        ready = Counter(p.version for p in self._pods_of(dep) if p.ready)
        # Unready old Pods go first: removing them costs no availability.
        budget = sum(sets.values()) - min_available - max(0, sets[new] - ready[new])
        for v in olds:
            cleanup = min(budget, max(0, sets[v] - ready[v]))
            if cleanup > 0:
                self._scale_rs(dep, v, sets[v] - cleanup)
                budget -= cleanup
        spare = sum(ready.values()) - min_available
        for v in olds:
            down = min(spare, sets[v])
            if down > 0:
                self._scale_rs(dep, v, sets[v] - down)
                spare -= down
        sig = (ready[new], sum(sets[v] for v in olds))
        if sig != dep.progress_sig:
            dep.progress_sig, dep.progress_at = sig, self.now
        elif not dep.stalled and self.now - dep.progress_at > PROGRESS_DEADLINE_SECONDS:
            dep.stalled = True
            self._event(dep, "ProgressDeadlineExceeded",
                        f"ReplicaSet \"{dep.rs_name(new)}\" has timed out progressing.", True)

    def _scale_rs(self, dep, version, replicas):
        before = dep.replica_sets.get(version, 0)
        dep.replica_sets[version] = replicas
        self._event(dep, "ScalingReplicaSet", f"Scaled {'up' if replicas > before else 'down'} replica set "
                                              f"{dep.rs_name(version)} from {before} to {replicas}")

    def _sync_rs(self, dep, version):
        """ReplicaSet controller: create or delete Pods until the count matches. It prefers deleting
        unscheduled, then not-ready, then the newest Pods."""
        want = dep.replica_sets[version]
        pods = [p for p in self._pods_of(dep) if p.version == version]
        for _ in range(want - len(pods)):
            self._create(dep, version)
        pods.sort(key=lambda p: (p.node is not None, p.ready, -p.created))
        for pod in pods[: max(0, len(pods) - want)]:
            self._rs_event(dep, version, "SuccessfulDelete", f"Deleted pod: {pod.name}")
            self._terminate(pod, "Killing", "Stopping container app")

    def _reconcile_set(self, dep: Deployment):
        """StatefulSet: Pods are name-0, name-1, … created in order, each only once the previous is ready,
        and never while a Pod with the same name still exists (two copies must not share one disk)."""
        everyone = {p.name: p for p in self._pods_of(dep, include_deleting=True)}
        for i in range(dep.replicas):
            name = f"{dep.name}-{i}"
            pod = everyone.get(name)
            if pod is None:
                claim = f"data-{name}"
                if claim not in self.claims:
                    self.claims[claim] = {"namespace": dep.namespace, "app": dep.name, "created": self.now}
                    self._event(dep, "SuccessfulCreate", f"create Claim {claim} Pod {name} in StatefulSet {dep.name} success",
                                component="statefulset-controller")
                uid = f"pod-{next(self._ids)}"
                self.pods[uid] = Pod(dep.namespace, dep.name, name, uid, self.now, version=dep.version, claim=claim)
                self._event(dep, "SuccessfulCreate", f"create Pod {name} in StatefulSet {dep.name} successful",
                            component="statefulset-controller")
                return  # OrderedReady: one at a time
            if not pod.ready:
                return
        for name, pod in sorted(everyone.items(), key=lambda kv: -int(kv[0].rsplit("-", 1)[1])):
            if int(name.rsplit("-", 1)[1]) >= dep.replicas and pod.deleting_at is None:
                self._terminate(pod, "Killing", f"Stopping container in pod {name} (scale down)")
                return  # highest ordinal first, one at a time; its claim (and data) is kept

    def _create(self, dep, version):
        uid = f"pod-{next(self._ids)}"
        pod = Pod(dep.namespace, dep.name, f"{dep.rs_name(version)}-{suffix(uid, 5)}", uid, self.now, version=version)
        self.pods[uid] = pod
        self._rs_event(dep, version, "SuccessfulCreate", f"Created pod: {pod.name}")

    def _autoscale(self, dep):
        hpa = dep.hpa
        if self.now - hpa.synced_at < HPA_SYNC_SECONDS:
            return
        hpa.synced_at = self.now
        ready = sum(p.ready for p in self._pods_of(dep))
        if not ready:
            return
        inbound = sum(e["rps"] for e in self.traffic() if e["to"] == f"{dep.namespace}/{dep.name}")
        hpa.metric = inbound / ready
        want = max(hpa.min, min(hpa.max, math.ceil(ready * hpa.metric / hpa.target_rps)))
        hpa.recommendations = [(t, d) for t, d in hpa.recommendations if self.now - t <= HPA_DOWNSCALE_WINDOW_SECONDS]
        hpa.recommendations.append((self.now, want))
        # Scale up at once; scale down only to the highest recommendation of the stabilisation window.
        hpa.desired = want if want >= dep.replicas else max(d for _, d in hpa.recommendations)
        if hpa.desired != dep.replicas:
            direction = "above" if hpa.desired > dep.replicas else "below"
            dep.replicas = hpa.desired
            self._event(dep, "SuccessfulRescale",
                        f"New size: {hpa.desired}; reason: pods metric requests_per_second {direction} target")

    def _node_lifecycle(self):
        """Node controller: a Node whose kubelet stops sending heartbeats is marked NotReady and tainted
        unreachable (its Pods leave their Services' endpoints). Pods tolerate that for a while, then the
        taint-eviction controller evicts them. They stay Terminating until the Node can confirm."""
        for node in self.nodes.values():
            if node.powered:
                node.heartbeat = self.now
            if node.ready and self.now - node.heartbeat > NODE_GRACE_SECONDS:
                node.ready, node.unreachable_since = False, self.now
                self._node_event(node.name, "NodeNotReady", f"Node {node.name} status is now: NodeNotReady", True)
                for pod in self.pods.values():
                    if pod.node == node.name:
                        pod.ready = False
            elif not node.ready and node.powered:
                node.ready, node.unreachable_since = True, None
                self._node_event(node.name, "NodeReady", f"Node {node.name} status is now: NodeReady", False)
            if not node.ready and self.now - node.unreachable_since >= TOLERATION_SECONDS:
                for pod in self.pods.values():
                    if pod.node == node.name and pod.deleting_at is None:
                        self._terminate(pod, "TaintManagerEviction", f"Marking for deletion Pod {pod.namespace}/{pod.name}", True)

    def _drain_step(self, node):
        """Evict every Pod on a draining Node, unless that would break its PodDisruptionBudget."""
        node.blocked = ""
        for pod in [p for p in self.pods.values() if p.node == node.name and p.deleting_at is None]:
            dep = self.deployments[f"{pod.namespace}/{pod.deployment}"]
            if pod.ready and dep.max_unavailable is not None:
                healthy = sum(p.ready for p in self._pods_of(dep))
                if healthy - (dep.replicas - dep.max_unavailable) < 1:
                    node.blocked = f"evicting {pod.name} would break the disruption budget of {dep.name}"
                    continue
            self._terminate(pod, "Killing", f"Stopping container in pod {pod.name} (evicted by drain)")
        if not node.blocked and not any(p.node == node.name for p in self.pods.values()):
            node.draining = False  # drained: cordoned and empty

    def _schedule(self):
        for pod in sorted(self.pods.values(), key=lambda p: p.created):
            if pod.node is not None or pod.deleting_at is not None:
                continue
            # Filter: Nodes without a NoSchedule/NoExecute taint (cordoned or unreachable) and with a free slot.
            load = {n: 0 for n, node in self.nodes.items() if node.ready and not node.cordoned}
            same = dict.fromkeys(load, 0)
            for p in self.pods.values():
                if p.node in load:
                    load[p.node] += 1
                    same[p.node] += p.namespace == pod.namespace and p.deployment == pod.deployment
            free = [n for n in load if load[n] < self.nodes[n].capacity]
            if not free:
                if pod.state != "Unschedulable":
                    pod.state = "Unschedulable"
                    self._event_pod(pod, "FailedScheduling",
                                    "0/%d nodes are available: insufficient capacity" % len(self.nodes), True)
                continue
            # Score: spread a workload's replicas across Nodes, then prefer the least loaded.
            pod.node = min(free, key=lambda n: (same[n], load[n], n))
            node = self.nodes[pod.node]
            pod.ip, node.next_ip = f"10.244.{node.index}.{node.next_ip}", node.next_ip % 250 + 2
            pod.state, pod.next_at = "ContainerCreating", self.now + POD_START_SECONDS
            self._event_pod(pod, "Scheduled", f"Successfully assigned {pod.namespace}/{pod.name} to {pod.node}")

    def _terminate(self, pod, reason, message, warning=False):
        if pod.deleting_at is None:
            pod.deleting_at, pod.ready = self.now + TERMINATE_SECONDS, False
            self._event_pod(pod, reason, message, warning)

    # ---------- events ----------
    def _event(self, dep, reason, message, warning=False, component=None):
        kind = "StatefulSet" if dep.kind == "StatefulSet" else (
            "HorizontalPodAutoscaler" if reason == "SuccessfulRescale" else "Deployment")
        self._push(kind, dep.namespace, dep.name, reason, message, warning, component)

    def _rs_event(self, dep, version, reason, message):
        self._push("ReplicaSet", dep.namespace, dep.rs_name(version), reason, message, False)

    def _event_pod(self, pod, reason, message, warning=False):
        component = COMPONENT.get(reason)
        self._push("Pod", pod.namespace, pod.name, reason, message, warning, component,
                   pod.node if component == "kubelet" else None)

    def _node_event(self, name, reason, message, warning):
        self._push("Node", "", name, reason, message, warning, None, name)

    def _push(self, kind, ns, name, reason, message, warning, component=None, instance=None):
        n = next(self._ids)
        self.events.append({
            "kind": "Event",
            "metadata": {"name": f"ev-{n}", "namespace": ns or "default", "uid": f"ev-{n}"},
            "involvedObject": {"kind": kind, "namespace": ns, "name": name},
            "reason": reason, "message": message,
            "type": "Warning" if warning else "Normal",
            "reportingComponent": component or COMPONENT.get(reason, "kuebec-simulator"),
            "reportingInstance": instance or "",
            "lastTimestamp": iso(self.now),
        })
        del self.events[:-60]

    # ---------- serialisation ----------
    def snapshot(self) -> dict[str, dict]:
        objs = []
        namespaces = sorted({d.namespace for d in self.deployments.values()})
        objs += [{"kind": "Namespace", "metadata": {"name": ns, "uid": f"ns-{ns}"}} for ns in namespaces]
        for n in self.nodes.values():
            meta = {"name": n.name, "uid": f"node-{n.name}", "annotations": {}}
            if n.cordoned:
                meta["annotations"]["kubeverse.io/drain"] = ("blocked: " + n.blocked if n.blocked
                                                             else "draining" if n.draining else "drained")
            if not n.powered:
                meta["annotations"]["kubeverse.io/power-cut"] = "true"  # the simulator knows; Kubernetes only sees silence
            taints = ([{"key": "node.kubernetes.io/unschedulable", "effect": "NoSchedule"}] if n.cordoned else []) + (
                [{"key": "node.kubernetes.io/unreachable", "effect": "NoExecute", "timeAdded": iso(n.unreachable_since)}]
                if not n.ready else [])
            objs.append({
                "kind": "Node", "metadata": meta, "spec": {"unschedulable": n.cordoned, "taints": taints},
                "status": {"capacity": {"pods": str(n.capacity)},
                           "conditions": [{"type": "Ready", "status": "True" if n.ready else "False"}]},
            })
        for key, d in self.deployments.items():
            pods = self._pods_of(d, include_deleting=True)
            live = [p for p in pods if p.deleting_at is None]
            ready = sum(p.ready for p in pods)
            annotations = {}
            if d.sabotaged:
                annotations["kubeverse.io/sabotaged"] = "true"
            labels = {"app": d.name, "version": d.version}
            if d.kind == "StatefulSet":
                objs.append({
                    "kind": "StatefulSet",
                    "metadata": {"name": d.name, "namespace": d.namespace, "uid": d.uid, "annotations": annotations},
                    "spec": {"replicas": d.replicas, "serviceName": d.name, "podManagementPolicy": "OrderedReady",
                             "selector": {"matchLabels": {"app": d.name}}, "template": {"metadata": {"labels": labels}},
                             "volumeClaimTemplates": [{"metadata": {"name": "data"}, "spec": {"resources": {"requests": {"storage": "1Gi"}}}}]},
                    "status": {"replicas": len(pods), "readyReplicas": ready, "currentReplicas": len(live)},
                })
            else:
                updated = [p for p in live if p.version == d.version]
                annotations["deployment.kubernetes.io/revision"] = str(d.revision)
                annotations["kubeverse.io/latest-version"] = max(d.history, key=lambda v: int(v[1:]))
                if d.version in d.buggy:
                    annotations["kubeverse.io/buggy-release"] = "true"
                previous = next((v for v in reversed(d.history) if v != d.version), None)
                if previous:
                    annotations["kubeverse.io/previous-version"] = previous
                for v, want in d.replica_sets.items():
                    mine = [p for p in pods if p.version == v]
                    rs_labels = {**labels, "version": v, "pod-template-hash": d.rs_name(v).rsplit("-", 1)[1]}
                    objs.append({
                        "kind": "ReplicaSet",
                        "metadata": {"name": d.rs_name(v), "namespace": d.namespace, "uid": f"rs-{d.uid}-{v}",
                                     "labels": rs_labels,
                                     "annotations": {"deployment.kubernetes.io/revision": str(
                                         max(i + 1 for i, h in enumerate(d.history) if h == v))},
                                     "ownerReferences": [{"kind": "Deployment", "name": d.name, "uid": d.uid, "controller": True}]},
                        "spec": {"replicas": want, "selector": {"matchLabels": rs_labels},
                                 "template": {"metadata": {"labels": rs_labels}}},
                        "status": {"replicas": len(mine), "readyReplicas": sum(p.ready for p in mine)},
                    })
                rolling = len(updated) < len(live) or len(updated) < d.replicas or sum(p.ready for p in updated) < d.replicas
                progressing = ({"type": "Progressing", "status": "False", "reason": "ProgressDeadlineExceeded"} if d.stalled and rolling
                               else {"type": "Progressing", "status": "True",
                                     "reason": "ReplicaSetUpdated" if rolling else "NewReplicaSetAvailable"})
                objs.append({
                    "kind": "Deployment",
                    "metadata": {"name": d.name, "namespace": d.namespace, "uid": d.uid, "annotations": annotations},
                    "spec": {"replicas": d.replicas, "selector": {"matchLabels": {"app": d.name}},
                             "strategy": {"type": "RollingUpdate", "rollingUpdate": {"maxSurge": "25%", "maxUnavailable": "25%"}},
                             "template": {"metadata": {"labels": labels}}},
                    "status": {"replicas": len(pods), "readyReplicas": ready,
                               "updatedReplicas": len(updated), "conditions": [progressing]},
                })
            objs.append({
                "kind": "Service",
                "metadata": {"name": d.name, "namespace": d.namespace, "uid": f"svc-{d.uid}"},
                "spec": {"selector": {"app": self.services[key]}},
            })
            # The EndpointSlice controller lists the Service's Pods; kube-proxy only routes to ready ones.
            objs.append({
                "kind": "EndpointSlice",
                "metadata": {"name": f"{d.name}-{suffix(d.uid, 5)}", "namespace": d.namespace, "uid": f"eps-{d.uid}",
                             "labels": {"kubernetes.io/service-name": d.name}},
                "addressType": "IPv4",
                "endpoints": [{"addresses": [p.ip], "nodeName": p.node, "targetRef": {"kind": "Pod", "name": p.name},
                               "conditions": {"ready": p.ready, "serving": p.ready, "terminating": p.deleting_at is not None}}
                              for p in sorted(pods, key=lambda p: p.name) if p.ip],
                "ports": [{"port": 8080, "protocol": "TCP"}],
            })
            if d.max_unavailable is not None:
                healthy = sum(p.ready for p in live)
                objs.append({
                    "kind": "PodDisruptionBudget",
                    "metadata": {"name": d.name, "namespace": d.namespace, "uid": f"pdb-{d.uid}"},
                    "spec": {"maxUnavailable": d.max_unavailable, "selector": {"matchLabels": {"app": d.name}}},
                    "status": {"currentHealthy": healthy, "desiredHealthy": d.replicas - d.max_unavailable,
                               "disruptionsAllowed": max(0, healthy - (d.replicas - d.max_unavailable))},
                })
            if d.hpa:
                objs.append({
                    "kind": "HorizontalPodAutoscaler",
                    "metadata": {"name": d.name, "namespace": d.namespace, "uid": f"hpa-{d.uid}"},
                    "spec": {"scaleTargetRef": {"kind": d.kind, "name": d.name},
                             "minReplicas": d.hpa.min, "maxReplicas": d.hpa.max,
                             "metrics": [{"type": "Pods", "pods": {"metric": {"name": "requests_per_second"},
                                                                    "target": {"type": "AverageValue", "averageValue": f"{d.hpa.target_rps:g}"}}}]},
                    "status": {"currentReplicas": ready, "desiredReplicas": d.replicas,
                               "currentMetrics": [{"type": "Pods", "pods": {"current": {"averageValue": f"{d.hpa.metric:.1f}"}}}]},
                })
        for name, c in self.claims.items():
            objs.append({
                "kind": "PersistentVolumeClaim",
                "metadata": {"name": name, "namespace": c["namespace"], "uid": f"pvc-{name}", "labels": {"app": c["app"]},
                             "creationTimestamp": iso(c["created"])},
                "spec": {"resources": {"requests": {"storage": "1Gi"}}},
                "status": {"phase": "Bound"},
            })
        for ing in self.ingresses:
            svc = ing.service.split("/")[1]
            objs.append({
                "kind": "Ingress", "metadata": {"name": ing.name, "namespace": ing.namespace, "uid": f"ing-{ing.namespace}-{ing.name}"},
                "spec": {"rules": [{"host": ing.host, "http": {"paths": [
                    {"path": "/", "pathType": "Prefix", "backend": {"service": {"name": svc, "port": {"number": 80}}}}]}}]},
                "status": {"kubeverse.io/rush-hour": self.now < self.rush_until},
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
        dep = self.deployments[f"{p.namespace}/{p.deployment}"]
        owner = ({"kind": "StatefulSet", "name": dep.name, "uid": dep.uid} if dep.kind == "StatefulSet"
                 else {"kind": "ReplicaSet", "name": dep.rs_name(p.version), "uid": f"rs-{dep.uid}-{p.version}"})
        meta = {"name": p.name, "namespace": p.namespace, "uid": p.uid,
                "labels": {"app": p.deployment, "version": p.version}, "creationTimestamp": iso(p.created),
                "ownerReferences": [{**owner, "controller": True}]}
        if dep.kind == "Deployment":
            meta["labels"]["pod-template-hash"] = owner["name"].rsplit("-", 1)[1]
        if p.version in dep.buggy:
            meta["annotations"] = {"kubeverse.io/buggy-release": "true"}
        if p.deleting_at is not None:
            meta["deletionTimestamp"] = iso(p.deleting_at)
        spec = {"nodeName": p.node, "containers": [{"name": "app", "image": f"{p.deployment}:{p.version}"}]}
        if p.claim:
            spec["volumes"] = [{"name": "data", "persistentVolumeClaim": {"claimName": p.claim}}]
        return {
            "kind": "Pod", "metadata": meta, "spec": spec,
            "status": {
                # Real phase semantics: CrashLoopBackOff pods are still phase Running.
                "phase": "Pending" if p.state in (None, "Unschedulable", "ContainerCreating") else "Running",
                "podIP": p.ip, "hostIP": p.node and f"192.168.0.{self.nodes[p.node].index + 10}",
                "conditions": [{"type": t, "status": "True" if ok else "False"} for t, ok in (
                    ("PodScheduled", p.node is not None), ("ContainersReady", p.ready), ("Ready", p.ready))],
                "containerStatuses": [{"name": "app", "ready": p.ready, "restartCount": p.restarts,
                                       "state": state}],
            },
        }

    def traffic(self) -> list[dict]:
        """Request flows. Demand starts at the Ingress and flows down the call graph: a service only calls
        what it needs while it is serving requests itself, in the proportions of the demo's healthy rates.
        `healthy`: the target has ready Pods to answer at all. `errors`: it answers, but with errors,
        because something it depends on (directly or further down) is down."""
        def ready(key):
            d = self.deployments[key]
            return sum(p.ready for p in self.pods.values() if p.namespace == d.namespace and p.deployment == d.name)
        down = {k for k in self.deployments if ready(k) == 0}
        def impacted(key, seen=()):
            return any(dst in down or (dst not in seen and impacted(dst, (*seen, key)))
                       for src, dst, _ in self.calls if src == key)
        rush = self.now < self.rush_until
        customers = RUSH_RPS if rush else INGRESS_RPS
        # Each call's share of its caller's inbound requests, from the healthy base rates.
        base_in = Counter()
        for ing in self.ingresses:
            base_in[ing.service] += INGRESS_RPS
        for _, dst, rps in self.calls:
            base_in[dst] += rps
        inbound, rates = Counter({ing.service: customers for ing in self.ingresses}), {}
        for _ in range(len(self.deployments)):  # one pass per call-graph level (bounded, so cycles stop)
            for src, dst, rps in self.calls:
                if src in down:
                    rates[src, dst] = 0.0
                elif base_in[src]:
                    rates[src, dst] = round(inbound[src] * rps / base_in[src], 2)
                else:  # nobody calls it: it generates its own work (a worker, a cron job)
                    rates[src, dst] = rps * (customers / INGRESS_RPS)
            inbound = Counter({ing.service: customers for ing in self.ingresses})
            for (src, dst), rps in rates.items():
                inbound[dst] += rps
        # Latency and errors, as callers measure them. A service's own time grows sharply once its ready
        # Pods get more than POD_RPS each; it then waits on what it calls, in proportion to how often.
        share = {(src, dst): min(1.0, rps / base_in[src]) if base_in[src] else 1.0 for src, dst, rps in self.calls}
        def own(key):
            util = inbound[key] / max(ready(key), 1) / POD_RPS
            return self.deployments[key].latency_ms * (1 + min(util ** 4, 24))
        def latency(key, seen=()):
            return own(key) + sum(share[src, dst] * (REFUSED_MS if dst in down else latency(dst, (*seen, key)))
                                  for src, dst, _ in self.calls if src == key and dst not in seen)
        def failing(key, seen=()):  # share of its requests that fail because something it needs is down
            ok = 1.0
            for src, dst, _ in self.calls:
                if src == key and dst not in seen:
                    ok *= 1 - share[src, dst] * (1.0 if dst in down else failing(dst, (*seen, key)))
            return 1 - ok
        def measured(dst, rps):
            if dst in down:
                return {"rps": rps, "healthy": False, "errors": False, "error_rate": 0.0, "refused_rate": 1.0,
                        "latency_ms": REFUSED_MS if rps else None}
            fail = round(failing(dst), 3)
            return {"rps": rps, "healthy": True, "errors": fail > 0, "error_rate": fail, "refused_rate": 0.0,
                    "latency_ms": round(latency(dst), 1) if rps else None}
        edges = [{"from": src, "to": dst, **measured(dst, rates[src, dst])} for src, dst, _ in self.calls]
        # Customers arrive through each Ingress; it only works while its Service has ready Pods.
        for ing in self.ingresses:
            edges.append({"from": f"ingress:{ing.namespace}/{ing.name}", "to": ing.service, **measured(ing.service, customers)})
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
        return [{"type": "SOURCE", "context": None}] + \
               [{"type": "ADDED", "object": o} for o in self._last.values()] + \
               [{"type": "TRAFFIC", "edges": self._last_traffic or []}]


def demo_cluster() -> Simulator:
    sim = Simulator()
    for i in range(1, 4):
        sim.add_node(f"node-{i}", capacity=6)  # room to drain one Power Station without leaving Pods Pending
    sim.add_deployment("shop", "frontend", 3, [("shop/cart", 6), ("shop/checkout", 3)], max_unavailable=1,
                       hpa=Autoscaler(min=3, max=7, target_rps=4.0), latency_ms=25)
    sim.add_deployment("shop", "cart", 2, [("data/redis", 5)], max_unavailable=1, latency_ms=12)
    sim.add_deployment("shop", "checkout", 2, [("shop/payments", 2), ("data/postgres", 3)], max_unavailable=1, latency_ms=35)
    sim.add_deployment("shop", "payments", 2, max_unavailable=1, latency_ms=110)
    sim.add_deployment("data", "postgres", 1, kind="StatefulSet", latency_ms=8)
    sim.add_deployment("data", "redis", 1, latency_ms=2)
    sim.add_ingress("shop", "storefront", "shop.portkube.local", "shop/frontend")
    return sim
