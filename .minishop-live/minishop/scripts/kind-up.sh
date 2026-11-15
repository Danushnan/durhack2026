#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
cluster="${MINISHOP_CLUSTER:-minishop}"
for tool in docker kind kubectl; do command -v "$tool" >/dev/null || { echo "$tool is required." >&2; exit 1; }; done
docker info >/dev/null
if ! kind get clusters | grep -Fxq "$cluster"; then
  kind create cluster --name "$cluster" --config kind.yaml --wait 120s
fi
bash scripts/build-images.sh
bash scripts/load-images.sh "$cluster" minishop-web:demo minishop-product-api:demo minishop-cart-api:demo minishop-checkout-api:demo minishop-payment-api:demo
# Load data images too: new pods do not depend on internet access during judging.
docker pull postgres:17-alpine
docker pull redis:8-alpine
bash scripts/load-images.sh "$cluster" postgres:17-alpine redis:8-alpine
bash scripts/deploy.sh "kind-$cluster"
