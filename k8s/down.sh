#!/usr/bin/env bash
# Remove the KubeVerse live demo (deletes the shop and data namespaces).
set -euo pipefail
kubectl --context "${1:-docker-desktop}" delete namespace shop data --ignore-not-found
