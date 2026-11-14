"""Simulated Cluster: a tiny Kubernetes-like reconciler.

Pure module: no asyncio, no clock. Call tick(now) and read the watch events it returns.
Objects are serialised in (trimmed) Kubernetes shapes so a real cluster can replace this later.
"""
from dataclasses import dataclass, field
from datetime import datetime, timezone
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

# Which part of Kubernetes reports each event (Event.reportingComponent).
COMPONENT = {
    "SuccessfulCreate": "replicaset-controller", "SuccessfulDelete": "replicaset-controller",
    "ScalingReplicaSet": "deployment-controller", "DeploymentRollback": "deployment-controller",
    "ProgressDeadlineExceeded": "deployment-controller",
    "Scheduled": "default-scheduler", "FailedScheduling": "default-scheduler",
    "Started": "kubelet", "BackOff": "kubelet", "Killing": "kubelet",
    "NodeNotSchedulable": "kubelet", "NodeSchedulable": "kubelet",
    "NodeNotReady": "node-controller", "NodeReady": "node-controller",
    "TaintManagerEviction": "taint-eviction-controller",
    "SuccessfulRescale": "horizontal-pod-autoscaler",
}


def iso(t: float) -> str:
    return datetime.fromtimestamp(t, timezone.utc).isoformat()


@dataclass
class Node:
    name: str
    capacity: int
    ready: bool = True
    cordoned: bool = False         # unschedulable: no new Pods (kubectl cordon / drain)
    draining: bool = False
    blocked: str = ""              # why the drain is waiting, if it is


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
        self.nodes[name] = Node(name, capacity)

    def add_deployment(self, ns, name, replicas, calls=(), kind="Deployment", max_unavailable=None, hpa=None):
        key = f"{ns}/{name}"
        self.deployments[key] = Deployment(ns, name, replicas, uid=f"dep-{next(self._ids)}", kind=kind,
                                           max_unavailable=max_unavailable, hpa=hpa)
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
        dep.replicas = max(0, min(MAX_REPLICAS, replicas))
        if dep.kind == "Deployment":
            self._event(dep, "ScalingReplicaSet", f"Scaled {name} to {dep.replicas}")
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
        node = self.nodes.get(name)
        if not node:
            return False
        node.ready = not enabled
        if enabled:
            self._node_event(name, "NodeNotReady", f"Node {name} status is now: NodeNotReady", True)
            # shortcut: real eviction waits ~5 min (tolerationSeconds); here it is immediate.
            for pod in list(self.pods.values()):
                if pod.node == name and pod.deleting_at is None:
                    self._terminate(pod, "TaintManagerEviction", f"Marking for deletion Pod {pod.namespace}/{pod.name}", True)
        else:
            self._node_event(name, "NodeReady", f"Node {name} status is now: NodeReady", False)
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
            self._step_pod(pod)
        for dep in self.deployments.values():
            if dep.hpa:
                self._autoscale(dep)
            if dep.kind == "StatefulSet":
                self._reconcile_set(dep)
            else:
                self._reconcile(dep)
        for node in self.nodes.values():
            if node.draining:
                self._drain_step(node)
        self._schedule()
        return self._diff()

    def _step_pod(self, pod: Pod):
        dep = self.deployments[f"{pod.namespace}/{pod.deployment}"]
        if pod.deleting_at is not None:
            # A Pod on a dead Node cannot confirm it stopped, so it stays Terminating until the Node returns.
            if self.now >= pod.deleting_at and (pod.node is None or self.nodes[pod.node].ready):
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
        live = self._pods_of(dep)
        current = [p for p in live if p.version == dep.version]
        old = [p for p in live if p.version != dep.version]
        if not old:
            for _ in range(dep.replicas - len(live)):
                self._create(dep)
            if len(live) > dep.replicas:
                # Kubernetes prefers removing unscheduled, then not-ready, then newest pods.
                live.sort(key=lambda p: (p.node is not None, p.ready, -p.created))
                for pod in live[: len(live) - dep.replicas]:
                    self._terminate(pod, "Killing", f"Stopping container in pod {pod.name} (scale down)")
            return
        self._roll(dep, current, old)

    def _roll(self, dep, current, old):
        """One step of a rolling update: add new-version Pods within the surge allowance, and remove
        old ones only while enough Pods stay ready. A new version that never becomes ready stalls here,
        with the old version still serving."""
        surge = math.ceil(dep.replicas * MAX_SURGE)
        min_ready = dep.replicas - math.floor(dep.replicas * MAX_UNAVAILABLE)
        new_total = min(dep.replicas, dep.replicas + surge - len(old))
        if new_total > len(current):
            for _ in range(new_total - len(current)):
                self._create(dep)
            self._event(dep, "ScalingReplicaSet", f"Scaled up replica set {dep.name}-{dep.version} to {new_total}")
        ready = sum(p.ready for p in current + old)
        for pod in sorted(old, key=lambda p: (p.ready, p.node is not None, -p.created)):
            if pod.ready and ready - 1 < min_ready:
                break
            ready -= pod.ready
            old.remove(pod)
            self._terminate(pod, "Killing", f"Stopping container in pod {pod.name} (rolling update)")
            self._event(dep, "ScalingReplicaSet",
                        f"Scaled down replica set {dep.name}-{pod.version} to {sum(p.version == pod.version for p in old)}")
        sig = (sum(p.ready for p in current), len(old))
        if sig != dep.progress_sig:
            dep.progress_sig, dep.progress_at = sig, self.now
        elif not dep.stalled and self.now - dep.progress_at > PROGRESS_DEADLINE_SECONDS:
            dep.stalled = True
            self._event(dep, "ProgressDeadlineExceeded",
                        f"ReplicaSet {dep.name}-{dep.version} has timed out progressing", True)

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

    def _create(self, dep):
        uid = f"pod-{next(self._ids)}"
        pod = Pod(dep.namespace, dep.name, f"{dep.name}-{uid[4:]:0>5}", uid, self.now, version=dep.version)
        self.pods[uid] = pod
        self._event(dep, "SuccessfulCreate", f"Created pod: {pod.name}")

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
            load = {n: 0 for n, node in self.nodes.items() if node.ready and not node.cordoned}
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
    def _event(self, dep, reason, message, warning=False, component=None):
        kind = "StatefulSet" if dep.kind == "StatefulSet" else (
            "ReplicaSet" if reason in ("SuccessfulCreate", "SuccessfulDelete") else
            "HorizontalPodAutoscaler" if reason == "SuccessfulRescale" else "Deployment")
        self._push(kind, dep.namespace, dep.name, reason, message, warning, component)

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
            meta = {"name": n.name, "uid": f"node-{n.name}"}
            if n.cordoned:
                meta["annotations"] = {"kubeverse.io/drain": "blocked: " + n.blocked if n.blocked
                                       else "draining" if n.draining else "drained"}
            objs.append({
                "kind": "Node", "metadata": meta, "spec": {"unschedulable": n.cordoned},
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
        meta = {"name": p.name, "namespace": p.namespace, "uid": p.uid,
                "labels": {"app": p.deployment, "version": p.version}, "creationTimestamp": iso(p.created)}
        if p.version in self.deployments[f"{p.namespace}/{p.deployment}"].buggy:
            meta["annotations"] = {"kubeverse.io/buggy-release": "true"}
        if p.deleting_at is not None:
            meta["deletionTimestamp"] = iso(p.deleting_at)
        spec = {"nodeName": p.node}
        if p.claim:
            spec["volumes"] = [{"name": "data", "persistentVolumeClaim": {"claimName": p.claim}}]
        return {
            "kind": "Pod", "metadata": meta, "spec": spec,
            "status": {
                # Real phase semantics: CrashLoopBackOff pods are still phase Running.
                "phase": "Pending" if p.state in (None, "Unschedulable", "ContainerCreating") else "Running",
                "conditions": [{"type": "Ready", "status": "True" if p.ready else "False"}],
                "containerStatuses": [{"name": "app", "ready": p.ready, "restartCount": p.restarts,
                                       "state": state}],
            },
        }

    def traffic(self) -> list[dict]:
        """Request flows. `healthy`: the target has ready Pods to answer at all. `errors`: it answers,
        but with errors, because something it depends on (directly or further down) is down."""
        def ready(key):
            d = self.deployments[key]
            return sum(p.ready for p in self.pods.values() if p.namespace == d.namespace and p.deployment == d.name)
        down = {k for k in self.deployments if ready(k) == 0}
        def impacted(key, seen=()):
            return any(dst in down or (dst not in seen and impacted(dst, (*seen, key)))
                       for src, dst, _ in self.calls if src == key)
        rush = self.now < self.rush_until
        load = RUSH_RPS / INGRESS_RPS if rush else 1.0  # internal calls rise with customer traffic
        edges = []
        for src, dst, rps in self.calls:
            edges.append({"from": src, "to": dst, "rps": round(rps * load, 2) if ready(src) else 0.0,
                          "healthy": dst not in down, "errors": dst not in down and impacted(dst)})
        # Customers arrive through each Ingress; it only works while its Service has ready Pods.
        for ing in self.ingresses:
            edges.append({"from": f"ingress:{ing.namespace}/{ing.name}", "to": ing.service,
                          "rps": RUSH_RPS if rush else INGRESS_RPS,
                          "healthy": ing.service not in down, "errors": ing.service not in down and impacted(ing.service)})
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
                       hpa=Autoscaler(min=3, max=7, target_rps=4.0))
    sim.add_deployment("shop", "cart", 2, [("data/redis", 5)], max_unavailable=1)
    sim.add_deployment("shop", "checkout", 2, [("shop/payments", 2), ("data/postgres", 3)], max_unavailable=1)
    sim.add_deployment("shop", "payments", 2, max_unavailable=1)
    sim.add_deployment("data", "postgres", 1, kind="StatefulSet")
    sim.add_deployment("data", "redis", 1)
    sim.add_ingress("shop", "storefront", "shop.portkube.local", "shop/frontend")
    return sim
