#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
command -v docker >/dev/null || { echo 'Docker CLI is required.' >&2; exit 1; }
docker info >/dev/null
for entry in 'product-api:products' 'cart-api:cart' 'checkout-api:checkout' 'payment-api:payments'; do
  name="${entry%%:*}"; service="${entry##*:}"
  docker build -f services/Dockerfile --build-arg "SERVICE=$service" -t "minishop-$name:demo" .
done
docker build -f frontend/Dockerfile -t minishop-web:demo .
