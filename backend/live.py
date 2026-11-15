"""Read cluster snapshots using the user's kubectl credentials."""

import json
import logging
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from live_telemetry import LiveTelemetry, iso

WINDOW_MS = 5000
MAX_FAILURES = 200
# Architecture manifests (like minishop/architecture.json) declare each app's dependencies, so its
# Roads exist before the first request and stay when traffic stops.
MANIFESTS = sorted(Path(__file__).resolve().parent.parent.glob("*/architecture.json"))

logger = logging.getLogger(__name__)


def kubectl(*args):
    return subprocess.run(
        ["kubectl", *args], capture_output=True, text=True,
        encoding="utf-8", check=True, timeout=15,
    ).stdout


class LiveCluster:
    def __init__(self, context):
        self.context = context
        self.objects = {}
        self.edges = []
        self.traffic_namespaces = set()
        self.declared = set()   # (from, to) pairs the workloads say they call
        self.learned = set()    # (from, to) pairs seen in logs since the backend started
        self.failures = []      # recent failed requests (newest last), deduped across overlapping log polls
        self.seen = set()
        self.log_pods = ()
        self.log_cursors = {}
        self.recovered_restarts = {}
        self.recovery_started = {}
        self.recovery_gaps = {}
        self.telemetry = LiveTelemetry(
            context, namespace=os.getenv("KUBEVERSE_TELEMETRY_NAMESPACE", "minishop"),
            window_seconds=float(os.getenv("KUBEVERSE_TELEMETRY_WINDOW_SECONDS", "10")),
            stale_seconds=float(os.getenv("KUBEVERSE_TELEMETRY_STALE_SECONDS", "10")),
            error_threshold=float(os.getenv("KUBEVERSE_TELEMETRY_ERROR_THRESHOLD", "0.1")),
            latency_threshold_ms=float(os.getenv("KUBEVERSE_TELEMETRY_LATENCY_THRESHOLD_MS", "1000")),
        )

    def refresh(self):
        """Compatibility entry point; the server schedules resources/logs separately."""
        return self.refresh_resources() + self.collect_logs() + self.update_traffic()

    def refresh_resources(self):
        raw = kubectl(
            "--context", self.context, "--request-timeout=5s", "get",
            "namespaces,nodes,deployments,replicasets,pods,services,events",
            "--all-namespaces", "-o", "json",
        )
        resources = json.loads(raw)["items"]
        self.traffic_namespaces = {
            item["metadata"]["namespace"] for item in resources
            if item["kind"] == "Deployment"
            and item["spec"]["template"]["metadata"].get("labels", {}).get("app.kubernetes.io/part-of") == "kubeverse-demo"
        }
        deployments = {item["metadata"]["uid"] for item in resources
                       if item["kind"] == "Deployment"}
        self.declared = declared_calls(resources)

        def controller(item):
            return next((ref["uid"] for ref in item["metadata"].get("ownerReferences", [])
                         if ref.get("controller")), None)

        owners = {item["metadata"]["uid"]: controller(item) for item in resources
                  if item["kind"] == "ReplicaSet"}
        deployment_names = {item["metadata"]["uid"]: item["metadata"]["name"]
                            for item in resources if item["kind"] == "Deployment"}
        log_pods = []
        for item in resources:
            meta = item["metadata"]
            if item["kind"] != "Pod" or meta.get("labels", {}).get("app.kubernetes.io/part-of") != "kubeverse-demo":
                continue
            deployment = deployment_names.get(owners.get(controller(item)))
            if deployment is None or not any(c["name"] == "workload" for c in item.get("spec", {}).get("containers", [])):
                continue
            status = next((c for c in item.get("status", {}).get("containerStatuses", []) if c["name"] == "workload"), {})
            pod_ready = next((c["status"] == "True" for c in item.get("status", {}).get("conditions", [])
                              if c.get("type") == "Ready"), status.get("ready", False))
            log_pods.append({"uid": meta["uid"], "name": meta["name"], "namespace": meta["namespace"],
                             "deployment": deployment, "service": f'{meta["namespace"]}/{deployment}',
                             "ready": status.get("ready", False) and pod_ready, "deleting": bool(meta.get("deletionTimestamp")),
                             "restarts": status.get("restartCount", 0)})
        current = {}
        for item in resources:
            kind = item["kind"]
            if kind == "ReplicaSet":
                continue
            meta = item["metadata"]
            item["metadata"] = {key: meta[key] for key in (
                "uid", "name", "namespace", "creationTimestamp", "deletionTimestamp"
            ) if key in meta}
            if kind == "Pod":
                item["deploymentUid"] = owners.get(controller({"metadata": meta}))
                if item["deploymentUid"] not in deployments:
                    continue
                item["spec"] = {"nodeName": item["spec"].get("nodeName")}
            elif kind == "Deployment":
                item["spec"] = {"replicas": item["spec"].get("replicas", 1)}
            current[meta["uid"]] = item
        # A manifest component missing from its (existing) namespace still gets its Building, so the
        # architecture never shrinks: an undeployed service is shown as such, with its Roads.
        present = {f'{item["metadata"]["namespace"]}/{item["metadata"]["name"]}'
                   for item in current.values() if item["kind"] == "Deployment"}
        namespaces = {item["metadata"]["name"] for item in current.values() if item["kind"] == "Namespace"}
        for namespace, name, _ in manifest_components():
            if namespace in namespaces and f"{namespace}/{name}" not in present:
                uid = f"manifest:{namespace}/{name}"
                current[uid] = {"kind": "Deployment", "metadata": {
                    "uid": uid, "name": name, "namespace": namespace,
                    "annotations": {"kubeverse.io/not-deployed": "true"}}, "spec": {"replicas": 0}, "status": {}}

        changes = [
            {"type": "MODIFIED" if uid in self.objects else "ADDED", "object": item}
            for uid, item in current.items() if self.objects.get(uid) != item
        ]
        changes.extend({"type": "DELETED", "object": item}
                       for uid, item in self.objects.items() if uid not in current)
        self.objects = current
        self.log_pods = tuple(log_pods)
        self.telemetry.set_resources(
            {f'{item["metadata"]["namespace"]}/{item["metadata"]["name"]}': item
             for item in current.values() if item["kind"] == "Deployment"}, log_pods, time.time())
        return changes

    def collect_logs(self):
        """One shared collection feeds service measurements and legacy traffic."""
        pods = self.log_pods
        active = {pod["uid"] for pod in pods}
        self.log_cursors = {uid: cursor for uid, cursor in self.log_cursors.items() if uid in active}
        self.recovered_restarts = {uid: count for uid, count in self.recovered_restarts.items() if uid in active}
        self.recovery_started = {uid: state for uid, state in self.recovery_started.items() if uid in active}
        self.recovery_gaps = {uid: until for uid, until in self.recovery_gaps.items()
                              if uid in active and until > time.time()}
        for pod in pods:
            if pod.get("restarts", 0) > self.recovered_restarts.get(pod["uid"], 0):
                previous = self.recovery_started.get(pod["uid"])
                if previous is None or previous[0] != pod["restarts"]:
                    self.recovery_started[pod["uid"]] = (pod["restarts"], time.time())
                    if pod["restarts"] - self.recovered_restarts.get(pod["uid"], 0) > 1:
                        self.recovery_gaps[pod["uid"]] = time.time() + self.telemetry.window_seconds + 2

        def read_pod(pod):
            now = time.time()
            since = max(now - self.telemetry.window_seconds - 2, self.log_cursors.get(pod["uid"], 0) - 2)
            args = ("--context", self.context, "--request-timeout=5s", "-n", pod["namespace"],
                    "logs", pod["name"], "-c", "workload", "--timestamps=true",
                    f"--since-time={iso(since)}", "--tail=10000")
            logs, recovery_error, recovered = [], None, False
            if pod.get("restarts", 0) > self.recovered_restarts.get(pod["uid"], 0):
                if now - self.recovery_started[pod["uid"]][1] > self.telemetry.window_seconds + 2:
                    # Unrecoverable prior-container records have left the live
                    # window. A healthy current stream may become complete again.
                    recovered = True
                else:
                    try:
                        logs.append(kubectl(*args, "--previous=true"))
                        recovered = True
                    except (OSError, subprocess.SubprocessError) as exc:
                        recovery_error = f'Previous logs unavailable for {pod["namespace"]}/{pod["name"]} ({type(exc).__name__})'
                        logger.warning(recovery_error)
            try:
                logs.append(kubectl(*args))
            except (OSError, subprocess.SubprocessError) as exc:
                reason = f'Log collection failed for {pod["namespace"]}/{pod["name"]} ({type(exc).__name__})'
                logger.warning(reason)
                return pod, now, since, logs, reason, recovered, False
            if self.recovery_gaps.get(pod["uid"], 0) > now:
                recovery_error = f'Multiple restarts observed for {pod["namespace"]}/{pod["name"]}; only latest previous container is recoverable'
            return pod, now, since, logs, recovery_error, recovered, True

        # Bounded parallel reads keep a multi-replica shop usable on a laptop.
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = [pool.submit(read_pod, pod) for pod in pods]
            for future in as_completed(futures):
                pod, now, since, streams, error, recovered, current_ok = future.result()
                # Ingest separately: current/previous overlap must share event IDs,
                # rather than receiving different occurrence ordinals.
                for logs in streams:
                    self.telemetry.ingest_logs(logs, pod, time.time())
                truncated = any(len(logs.splitlines()) >= 10000 for logs in streams)
                if truncated:
                    logger.warning("Live log limit reached for %s/%s; telemetry window is partial", pod["namespace"], pod["name"])
                self.telemetry.poll_result(pod["uid"], now, since=since, error=error,
                                           truncated=truncated, successful_read=current_ok)
                if recovered:
                    self.recovered_restarts[pod["uid"]] = pod["restarts"]
                if current_ok and error is None:
                    self.log_cursors[pod["uid"]] = now
        return []

    def update_traffic(self):
        """Expire roads on the publishing clock even if log reads are blocked."""
        changes = []
        edges = self.traffic()
        if edges != self.edges:
            self.edges = edges
            changes.append({"type": "TRAFFIC", "edges": edges})
        return changes

    def traffic(self, now=None):
        now = time.time() if now is None else now
        buildings = {f'{item["metadata"]["namespace"]}/{item["metadata"]["name"]}'
                     for item in self.objects.values() if item["kind"] == "Deployment"}
        samples = [{"from": row.source, "to": row.target, "at": row.observed_at * 1000,
                    "outcome": outcome({"status": row.status, "event": row.event, "error": row.error}),
                    "status": row.status, "id": row.event_id,
                    "detail": " ".join(v for v in (row.operation, row.route, row.error) if v),
                    "latency": None if row.operation == "orders.transaction" else row.latency_ms}
                   for row in self.telemetry.edge_observations(now)]
        edges = summarize(samples, buildings, self.declared | self.learned, now * 1000)
        self.learned |= {(e["from"], e["to"]) for e in edges if e["requests"]}
        def ident(f):
            return f["at"], f["from"], f["to"], f["id"], f["status"], f["detail"]
        # The --since=5s polls overlap, so the same log line arrives several times.
        for sample in sorted(samples, key=lambda x: x["at"]):
            if sample["outcome"] != "ok" and ident(sample) not in self.seen:
                self.seen.add(ident(sample))
                self.failures.append(sample)
        self.failures = self.failures[-MAX_FAILURES:]
        self.seen = {ident(f) for f in self.failures}
        for e in edges:
            # Only declared calls shape the layout, so a call first seen in the logs cannot move Buildings.
            e["declared"] = (e["from"], e["to"]) in self.declared
            e["recent_errors"] = [{k: f[k] for k in ("at", "status", "outcome", "detail")}
                                  for f in self.failures if (f["from"], f["to"]) == (e["from"], e["to"])][-5:]
        return edges

    def initial_events(self):
        return [{"type": "SOURCE", "context": self.context, "mode": "live"}] + [
            {"type": "ADDED", "object": item} for item in self.objects.values()
        ] + [{"type": "TRAFFIC", "edges": self.edges}]


def discover(context=None):
    contexts = [context] if context else kubectl("config", "get-contexts", "-o", "name").splitlines()
    if not context and contexts:
        active = kubectl_current()
        if active in contexts:
            contexts.remove(active)
            contexts.insert(0, active)
    for name in contexts:
        cluster = LiveCluster(name)
        try:
            cluster.refresh_resources()
        except (OSError, subprocess.SubprocessError):
            if context:
                raise
        else:
            return cluster
    return None


def kubectl_current():
    try:
        return kubectl("config", "current-context").strip()
    except subprocess.CalledProcessError:
        return None


def service_key(target, namespace):
    """`payments`, `redis.data` or `payment-api.minishop.svc.cluster.local` -> "namespace/name"."""
    parts = target.split(".")
    return f"{parts[1] if len(parts) > 1 else namespace}/{parts[0]}"


def manifest_components():
    """(namespace, deployment, dependencies) for every component of every architecture manifest."""
    out = []
    for manifest in MANIFESTS:
        try:
            spec = json.loads(manifest.read_text())
            out += [(spec["namespace"], c["deployment"], list(c.get("dependencies", []))) for c in spec["components"]]
        except (OSError, ValueError, KeyError, TypeError):
            logging.getLogger(__name__).warning("Ignoring unreadable architecture manifest %s", manifest)
    return out


def declared_calls(resources):
    """Dependencies the workloads declare: a CALLS (JSON [[target, rps]]) or DEPENDENCIES (space-separated)
    container env var, as the demo workloads use, plus every architecture manifest's dependency list."""
    calls = set()
    for item in resources:
        if item["kind"] != "Deployment":
            continue
        namespace, name = item["metadata"]["namespace"], item["metadata"]["name"]
        for container in item.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []):
            for env in container.get("env", []):
                value = env.get("value") or ""
                try:
                    targets = ([t for t, *_ in json.loads(value)] if env.get("name") == "CALLS"
                               else value.split() if env.get("name") == "DEPENDENCIES" else [])
                except (ValueError, TypeError):
                    targets = []
                calls |= {(f"{namespace}/{name}", service_key(t, namespace)) for t in targets}
    calls |= {(f"{namespace}/{name}", f"{namespace}/{d}") for namespace, name, deps in manifest_components() for d in deps}
    return calls


def outcome(sample):
    """'ok', 'error' (the callee answered, with an error) or 'refused' (nobody answered at all)."""
    status = int(sample["status"])
    if status < 400:
        return "ok"
    if sample.get("event") == "http_server":   # logged by the callee itself: it answered
        return "error"
    error = sample.get("error")
    if error:   # "HTTP 402" is an answer; an exception name (ConnectError, timeout) means no answer
        return "error" if str(error).startswith("HTTP ") else "refused"
    return "refused" if status in (503, 504) else "error"


def latency(sample):
    for field, scale in (("latency_ms", 1), ("duration_ms", 1), ("duration_seconds", 1000)):
        if isinstance(sample.get(field), (int, float)):
            return sample[field] * scale
    return None


def parse_samples(logs, namespace):
    out = []
    for line in logs.splitlines():
        try:
            sample = json.loads(line)
            out.append({"from": f'{namespace}/{sample["source"]}', "to": service_key(sample["target"], namespace),
                        "at": sample["timestamp_ms"], "outcome": outcome(sample), "status": int(sample["status"]),
                        "id": sample.get("request_id") or sample.get("pod"),
                        "detail": " ".join(str(sample[k]) for k in ("operation", "route", "error") if sample.get(k)),
                        # Checkout's orders.transaction timer spans the whole checkout (payment call
                        # included), so it says nothing about how fast PostgreSQL is.
                        "latency": None if sample.get("operation") == "orders.transaction" else latency(sample)})
        except (ValueError, TypeError, KeyError, AttributeError):
            continue
    return out


def summarize(samples, buildings, known, now_ms):
    """Edges for the last WINDOW_MS of samples. Every known call (declared or seen before) keeps its
    Road even when idle (rps 0), so the topology never disappears when traffic stops."""
    groups = {pair: [] for pair in known}
    for s in samples:
        if s["at"] >= now_ms - WINDOW_MS:
            groups.setdefault((s["from"], s["to"]), []).append(s)
    edges = []
    for (source, target), group in sorted(groups.items()):
        if source not in buildings or target not in buildings:
            continue
        n = len(group)
        refused = sum(s["outcome"] == "refused" for s in group) / n if n else 0.0
        errors = sum(s["outcome"] == "error" for s in group) / n if n else 0.0
        timed = [s["latency"] for s in group if s["latency"] is not None]
        edges.append({"from": source, "to": target, "rps": n / (WINDOW_MS / 1000), "requests": n,
                      "healthy": refused < 0.5, "errors": errors > 0,
                      "error_rate": round(errors, 3), "refused_rate": round(refused, 3),
                      "latency_ms": round(sum(timed) / len(timed), 1) if timed else None})
    return edges
