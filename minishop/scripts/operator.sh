#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${MINISHOP_DEMO_ENABLED:?Set MINISHOP_DEMO_ENABLED=1 explicitly}"
[[ "$MINISHOP_DEMO_ENABLED" == 1 ]] || { echo 'Demo mode is disabled.' >&2; exit 1; }
: "${MINISHOP_DEMO_TOKEN:?Set a random operator token of at least 24 characters}"
: "${MINISHOP_CONTEXT:?Set the dedicated MiniShop context explicitly}"
# A single worker owns the bounded traffic task. Never bind this service publicly.
exec "${MINISHOP_PYTHON:-python3}" -m uvicorn demo_control.app:app --host 127.0.0.1 --port 8090 --workers 1 --no-proxy-headers
