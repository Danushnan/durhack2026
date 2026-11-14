"""Read cluster snapshots using the user's kubectl credentials."""

import json
import subprocess
import time
import logging


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
        if edges != self.edges:
            self.edges = edges
            changes.append({"type": "TRAFFIC", "edges": edges})
        return changes

    def traffic(self):
        buildings = {f'{item["metadata"]["namespace"]}/{item["metadata"]["name"]}'
                     for item in self.objects.values() if item["kind"] == "Deployment"}
        samples = {}
        cutoff = time.time() * 1000 - 5000
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
            for line in logs.splitlines():
                try:
                    sample = json.loads(line)
                    target = sample["target"].split(".")
                    source = f'{namespace}/{sample["source"]}'
                    destination = f"{target[1] if len(target) > 1 else namespace}/{target[0]}"
                    timestamp = sample["timestamp_ms"]
                    if timestamp >= cutoff and source in buildings and destination in buildings:
                        samples.setdefault((source, destination), []).append(int(sample["status"]))
                except (ValueError, TypeError, KeyError):
                    continue
        # healthy: nobody refused the call (502/503/504 = no ready Pod answered).
        # errors: it answered, but with an error (e.g. 500 because something it depends on is failing).
        refused = {502, 503, 504}
        return [{"from": source, "to": target, "rps": len(results) / 5,
                 "healthy": not any(code in refused for code in results),
                 "errors": any(code >= 400 and code not in refused for code in results)}
                for (source, target), results in sorted(samples.items())]

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
