#!/usr/bin/env bash
# Start the KubeVerse live demo on a Kubernetes cluster (default: Docker Desktop).
set -euo pipefail
CONTEXT="${1:-docker-desktop}"
cd "$(dirname "$0")"
kubectl --context "$CONTEXT" apply -f - <<'NS'
apiVersion: v1
kind: Namespace
metadata: {name: shop}
---
apiVersion: v1
kind: Namespace
metadata: {name: data}
NS
for ns in shop data; do
  kubectl --context "$CONTEXT" -n "$ns" create configmap workload --from-file=workload.py --dry-run=client -o yaml \
    | kubectl --context "$CONTEXT" apply -f -
done
kubectl --context "$CONTEXT" apply -f demo.yaml
# Pods load workload.py once at start, so restart them to pick up a changed ConfigMap on a re-run.
kubectl --context "$CONTEXT" -n shop rollout restart deploy
kubectl --context "$CONTEXT" -n data rollout restart deploy
kubectl --context "$CONTEXT" -n shop rollout status deploy --timeout=180s
kubectl --context "$CONTEXT" -n data rollout status deploy --timeout=180s
echo "Demo running. Start the backend with: KUBEVERSE_CONTEXT=$CONTEXT .venv/bin/python -m uvicorn main:app --port 8000"
