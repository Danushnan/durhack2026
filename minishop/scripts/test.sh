#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
docker compose -f compose.yaml -f compose.test.yaml up -d --wait postgres redis
if ! docker compose exec -T postgres psql -U minishop -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='minishop_test'" | grep -q 1; then
  docker compose exec -T postgres createdb -U minishop minishop_test
fi
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
