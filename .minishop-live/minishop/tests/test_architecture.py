import json
from pathlib import Path
import yaml

ROOT = Path(__file__).resolve().parents[1]


def test_architecture_matches_real_workloads_and_routes():
    architecture = json.loads((ROOT / "architecture.json").read_text())
    docs = [doc for path in (ROOT / "k8s").glob("*.yaml") for doc in yaml.safe_load_all(path.read_text()) if doc]
    deployments = {d["metadata"]["name"]: d for d in docs if d["kind"] == "Deployment"}
    services = {d["metadata"]["name"]: d for d in docs if d["kind"] == "Service"}
    pvcs = {d["metadata"]["name"] for d in docs if d["kind"] == "PersistentVolumeClaim"}
    assert set(deployments) == {c["deployment"] for c in architecture["components"]}
    for component in architecture["components"]:
        name = component["id"]
        assert (ROOT / component["source"]).is_dir()
        assert all(target in deployments for target in component["dependencies"])
        deployment = deployments[name]
        pod = deployment["spec"]["template"]
        assert pod["metadata"]["labels"]["app.kubernetes.io/part-of"] == "kubeverse-demo"
        assert pod["metadata"]["labels"]["app"] == name
        assert deployment["spec"]["selector"]["matchLabels"] == services[name]["spec"]["selector"]
        container = pod["spec"]["containers"][0]
        assert container["name"] == "workload"
        assert container["ports"][0]["containerPort"] == component["port"]
        assert services[name]["spec"]["ports"][0]["targetPort"] == component["port"]
        assert all(probe in container for probe in ("readinessProbe", "livenessProbe", "startupProbe"))
        assert set(container["resources"]) == {"requests", "limits"}
        if "persistent_volume_claim" in component:
            assert component["persistent_volume_claim"] in pvcs
    config = next(d["data"] for d in docs if d["kind"] == "ConfigMap")
    for key in ("PRODUCT_URL", "CART_URL", "PAYMENT_URL", "REDIS_URL"):
        assert ".minishop.svc.cluster.local" in config[key]
        assert "localhost" not in config[key]
