#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Plain docker build also works on Docker installs without the buildx plugin.
bash scripts/build-images.sh
docker compose up -d --wait --no-build
