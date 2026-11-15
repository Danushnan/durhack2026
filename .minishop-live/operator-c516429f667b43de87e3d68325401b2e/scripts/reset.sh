#!/usr/bin/env bash
# Restore healthy settings without deleting orders, baskets, PVCs or the cluster.
set -euo pipefail
cd "$(dirname "$0")/.."
context="${MINISHOP_CONTEXT:-kind-${MINISHOP_CLUSTER:-minishop}}"
kubectl --context "$context" -n minishop set env deployment/payment-api PAYMENT_FAIL=false PAYMENT_DELAY_MS=100
kubectl --context "$context" -n minishop rollout status deployment/payment-api --timeout=120s
bash scripts/demo.sh scale 1
echo 'Healthy configuration restored. Persisted data and guest sessions are retained.'
