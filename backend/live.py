"""Read cluster snapshots using the user's kubectl credentials."""

import json
import logging
import psycopg
import subprocess
import time
from pathlib import Path

from live_history import event_id

WINDOW_MS = 5000
# Architecture manifests (like minishop/architecture.json) declare each app's dependencies, so its
# Roads exist before the first request and stay when traffic stops.
MANIFESTS = sorted(Path(__file__).resolve().parent.parent.glob("*/architecture.json"))


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
        self.history = None
        self.samples = []
        self.traffic_namespaces = set()
        self.declared = set()   # (from, to) pairs the workloads say they call
        self.learned = set()    # (from, to) pairs seen in logs since the backend started

    def refresh(self):
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

        changes = [
            {"type": "MODIFIED" if uid in self.objects else "ADDED", "object": item}
            for uid, item in current.items() if self.objects.get(uid) != item
        ]
        changes.extend({"type": "DELETED", "object": item}
                       for uid, item in self.objects.items() if uid not in current)
        self.objects = current
        edges = self.traffic()
        if self.history:
            try:
                self.history.record(self.samples, changes)
            except (psycopg.Error, OSError):
                logging.getLogger(__name__).warning("Could not save live telemetry")
        if edges != self.edges:
            self.edges = edges
            changes.append({"type": "TRAFFIC", "edges": edges})
        return changes

    def traffic(self):
        buildings = {f'{item["metadata"]["namespace"]}/{item["metadata"]["name"]}'
                     for item in self.objects.values() if item["kind"] == "Deployment"}
        samples = []
        for namespace in sorted(self.traffic_namespaces):
            try:
                logs = kubectl("--context", self.context, "--request-timeout=5s",
                               "-n", namespace, "logs", "-l",
                               "app.kubernetes.io/part-of=kubeverse-demo",
                               "-c", "workload", "--since=5s", "--tail=100",
                               "--ignore-errors=true")
            except (OSError, subprocess.SubprocessError):
                logging.getLogger(__name__).debug("Could not read demo logs in %s", namespace)
                continue
            samples += parse_samples(logs, namespace)
        self.samples = samples
        edges = summarize(samples, buildings, self.declared | self.learned, time.time() * 1000)
        self.learned |= {(e["from"], e["to"]) for e in edges if e["requests"]}
        return edges

    def initial_events(self):
        return [{"type": "SOURCE", "context": self.context}] + [
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
            cluster.refresh()
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


def declared_calls(resources):
    """Dependencies the workloads declare: a CALLS (JSON [[target, rps]]) or DEPENDENCIES (space-separated)
    container env var, as the demo workloads use, plus every architecture manifest's dependency list."""
    calls = set()
    for item in resources:
        if item["kind"] != "Deployment":
            continue
        namespace, name = item["metadata"]["namespace"], item["metadata"]["name"]
        for container in item["spec"]["template"]["spec"].get("containers", []):
            for env in container.get("env", []):
                value = env.get("value") or ""
                try:
                    targets = ([t for t, *_ in json.loads(value)] if env.get("name") == "CALLS"
                               else value.split() if env.get("name") == "DEPENDENCIES" else [])
                except (ValueError, TypeError):
                    targets = []
                calls |= {(f"{namespace}/{name}", service_key(t, namespace)) for t in targets}
    for manifest in MANIFESTS:
        try:
            spec = json.loads(manifest.read_text())
            namespace = spec["namespace"]
            calls |= {(f"{namespace}/{c['deployment']}", f"{namespace}/{d}")
                      for c in spec["components"] for d in c.get("dependencies", [])}
        except (OSError, ValueError, KeyError, TypeError):
            logging.getLogger(__name__).warning("Ignoring unreadable architecture manifest %s", manifest)
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
            if not isinstance(sample.get("timestamp_ms"), (int, float)):
                continue
            out.append({"event_id": event_id(namespace, line),
                        "request_id": sample.get("request_id") or sample.get("trace_id"),
                        "pod": sample.get("source_pod") or sample.get("pod"),
                        "method": sample.get("method"),
                        "route": (sample.get("route") or "").partition("?")[0] or None,
                        "status": sample.get("status"),
                        "error_kind": sample.get("error"),
                        "from": f'{namespace}/{sample["source"]}', "to": service_key(sample["target"], namespace),
                        "at": sample["timestamp_ms"], "outcome": outcome(sample),
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
