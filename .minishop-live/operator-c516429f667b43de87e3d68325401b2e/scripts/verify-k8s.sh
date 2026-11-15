#!/usr/bin/env bash
# Requires an already-running localhost:8080 frontend port-forward.
set -euo pipefail
cd "$(dirname "$0")/.."
context="${MINISHOP_CONTEXT:-kind-${MINISHOP_CLUSTER:-minishop}}"
k=(kubectl --context "$context" -n minishop)
restore() { bash scripts/reset.sh; }
trap restore EXIT
python3 scripts/smoke.py
bash scripts/demo.sh scale 3
python3 scripts/replicas.py --expect 3
old_uid="$("${k[@]}" get pods -l app=checkout-api -o jsonpath='{.items[0].metadata.uid}')"
bash scripts/demo.sh delete-pod
for _ in {1..60}; do
  if ! "${k[@]}" get pods -l app=checkout-api -o jsonpath='{.items[*].metadata.uid}' | grep -q "$old_uid"; then break; fi
  sleep 1
done
"${k[@]}" rollout status deployment/checkout-api --timeout=120s
"${k[@]}" get pods -l app=checkout-api -o json | python3 -c 'import json,sys; p=json.load(sys.stdin)["items"]; assert len(p)==3 and all(any(c["type"]=="Ready" and c["status"]=="True" for c in x["status"].get("conditions",[])) for x in p)'
python3 scripts/smoke.py
bash scripts/demo.sh fail-payment
python3 scripts/smoke.py --expect-payment-failure
bash scripts/demo.sh restore-payment
python3 scripts/smoke.py
echo 'PASS: real cluster checkout, three serving replicas, pod replacement, payment failure and recovery.'
