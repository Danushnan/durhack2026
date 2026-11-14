#!/bin/sh
set -eu
export DNS_RESOLVER="$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)"
export UPSTREAM_SUFFIX="${UPSTREAM_SUFFIX:-}"
exec /docker-entrypoint.sh "$@"
