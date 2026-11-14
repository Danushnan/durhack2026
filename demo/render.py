"""Render the demo objects as a kubectl-compatible JSON List."""

import json
from pathlib import Path

NAMESPACE = "kubeverse-demo"
SERVICES = {
    "gateway": (4, "catalog checkout auth.kubeverse-platform"),
    "catalog": (3, "inventory search.kubeverse-data"),
    "checkout": (3, "inventory payments shipping.kubeverse-fulfilment"),
    "inventory": (4, "cache.kubeverse-data"),
    "payments": (2, ""),
    "traffic": (1, ""),
}


DISTRICTS = {
    NAMESPACE: SERVICES,
    "kubeverse-platform": {
        "auth": (3, ""),
        "notifications": (2, ""),
    },
    "kubeverse-data": {
        "search": (3, "cache"),
        "cache": (4, ""),
    },
    "kubeverse-fulfilment": {
        "shipping": (3, "tracking notifications.kubeverse-platform"),
        "tracking": (2, ""),
    },
}


def resource(api_version, kind, name, namespace, **fields):
    metadata = {"name": name}
    if kind != "Namespace":
        metadata["namespace"] = namespace
    return {"apiVersion": api_version, "kind": kind, "metadata": metadata, **fields}


def deployment(name, replicas, dependencies, namespace):
    labels = {"app": name, "app.kubernetes.io/part-of": "kubeverse-demo"}
    container = {
        "name": "workload",
        "image": "python:3.12-alpine",
        "command": ["python", "/demo/workload.py"],
        "env": [{"name": "SERVICE", "value": name},
                {"name": "DEPENDENCIES", "value": dependencies},
                {"name": "POD_NAME", "valueFrom": {"fieldRef": {"fieldPath": "metadata.name"}}}],
        "resources": {"requests": {"cpu": "20m", "memory": "24Mi"},
                      "limits": {"memory": "96Mi"}},
        "volumeMounts": [{"name": "code", "mountPath": "/demo", "readOnly": True}],
    }
    if name != "traffic":
        probe = {"httpGet": {"path": "/health", "port": 8080}, "periodSeconds": 2}
        container.update(ports=[{"containerPort": 8080}], readinessProbe=probe,
                         livenessProbe={**probe, "periodSeconds": 5})
    return resource("apps/v1", "Deployment", name, namespace, spec={
        "replicas": replicas,
        "selector": {"matchLabels": labels},
        "template": {"metadata": {"labels": labels}, "spec": {
            "automountServiceAccountToken": False,
            "containers": [container],
            "volumes": [{"name": "code", "configMap": {"name": "workload"}}],
            "topologySpreadConstraints": [{
                "maxSkew": 1, "topologyKey": "kubernetes.io/hostname",
                "whenUnsatisfiable": "ScheduleAnyway", "labelSelector": {"matchLabels": labels},
            }],
        }},
    })


def main():
    code = Path(__file__).with_name("workload.py").read_text(encoding="utf-8")
    items = []
    for namespace, services in DISTRICTS.items():
        items.append(resource("v1", "Namespace", namespace, namespace))
        items.append(resource("v1", "ConfigMap", "workload", namespace,
                              data={"workload.py": code}))
        for name, (replicas, dependencies) in services.items():
            items.append(deployment(name, replicas, dependencies, namespace))
            if name != "traffic":
                items.append(resource("v1", "Service", name, namespace, spec={
                    "selector": {"app": name}, "ports": [{"port": 80, "targetPort": 8080}],
                }))
    print(json.dumps({"apiVersion": "v1", "kind": "List", "items": items}))


if __name__ == "__main__":
    main()
