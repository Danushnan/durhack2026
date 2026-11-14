#!/usr/bin/env bash
set -euo pipefail
cluster="$1"; shift
if kind load docker-image --name "$cluster" "$@"; then exit 0; fi
# Docker's containerd image store may save an index whose other platforms are
# absent. Older kind imports with --all-platforms; import only this host's
# platform instead, into the same real containerd store on every kind node.
platform="$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')"
while IFS= read -r node; do
  docker image save "$@" | docker exec --privileged -i "$node" ctr --namespace=k8s.io images import \
    --platform "$platform" --digests --snapshotter=overlayfs -
done < <(kind get nodes --name "$cluster")
