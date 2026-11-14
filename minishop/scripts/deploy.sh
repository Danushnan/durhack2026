#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
context="${1:-kind-${MINISHOP_CLUSTER:-minishop}}"
k=(kubectl --context "$context" -n minishop)
"${k[@]}" get namespace minishop >/dev/null 2>&1 && "${k[@]}" delete job minishop-migrate --ignore-not-found=true --wait=true
"${k[@]}" apply -k k8s
"${k[@]}" set env deployment/payment-api PAYMENT_FAIL=false PAYMENT_DELAY_MS=100
"${k[@]}" rollout status deployment/postgres --timeout=180s
"${k[@]}" rollout status deployment/redis --timeout=180s
"${k[@]}" wait --for=condition=complete job/minishop-migrate --timeout=300s
# Rebuilt :demo tags need an explicit restart to replace existing application pods.
for deployment in product-api cart-api checkout-api payment-api minishop-web; do
  "${k[@]}" rollout restart "deployment/$deployment"
  "${k[@]}" rollout status "deployment/$deployment" --timeout=180s
done
"${k[@]}" get deployments,pods,services,pvc -o wide
echo "Ready. Run: kubectl --context $context -n minishop port-forward service/minishop-web 8080:8080"
