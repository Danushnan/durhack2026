#!/usr/bin/env bash
set -euo pipefail
context="${MINISHOP_CONTEXT:-kind-${MINISHOP_CLUSTER:-minishop}}"
k=(kubectl --context "$context" -n minishop)
case "${1:-}" in
  fail-payment|restore-payment)
    value=false; [[ "$1" == fail-payment ]] && value=true
    "${k[@]}" set env deployment/payment-api "PAYMENT_FAIL=$value"
    "${k[@]}" rollout status deployment/payment-api --timeout=120s
    ;;
  delay-payment)
    delay="${2:-2000}"
    [[ "$delay" =~ ^[0-9]+$ ]] && (( delay <= 8000 )) || { echo 'Delay must be 0..8000 ms' >&2; exit 1; }
    "${k[@]}" set env deployment/payment-api "PAYMENT_DELAY_MS=$delay"
    "${k[@]}" rollout status deployment/payment-api --timeout=120s
    ;;
  scale)
    replicas="${2:-3}"
    [[ "$replicas" =~ ^[1-3]$ ]] || { echo 'Use 1, 2 or 3 replicas.' >&2; exit 1; }
    "${k[@]}" scale deployment/checkout-api "--replicas=$replicas"
    "${k[@]}" rollout status deployment/checkout-api --timeout=120s
    "${k[@]}" get pods -l app=checkout-api -o wide
    ;;
  delete-pod)
    # Delete exactly one healthy replica, not every pod matching the label.
    pod="$("${k[@]}" get pods -l app=checkout-api --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')"
    [[ -n "$pod" ]] || { echo 'No running Checkout pod found.' >&2; exit 1; }
    "${k[@]}" delete pod "$pod" --wait=false
    echo "Deleted $pod. Watch its replacement: kubectl --context $context -n minishop get pods -l app=checkout-api -w"
    ;;
  logs)
    "${k[@]}" logs -l app.kubernetes.io/part-of=kubeverse-demo -c workload --since=5m --tail=1000 --max-log-requests=20 --prefix=false
    ;;
  *) echo 'Usage: scripts/demo.sh {fail-payment|restore-payment|delay-payment [ms]|scale [1..3]|delete-pod|logs}' >&2; exit 1;;
esac
