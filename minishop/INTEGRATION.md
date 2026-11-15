# KubeVerse integration assessment

Inspected without changes: `../backend/live.py`, `../backend/main.py`, `../backend/telemetry.py`, `../backend/sim.py`, and the repository README. This note describes the adapter present on 14 November 2026.

## Resource discovery and source mapping

`LiveCluster.refresh()` reads namespaces, nodes, Deployments, ReplicaSets, Pods, Services and Events via the user’s `kubectl` context. Resources are identified by Kubernetes metadata UID. Pods are associated by Pod controller UID → ReplicaSet controller UID → Deployment UID. Pods outside that ownership chain are currently skipped.

MiniShop therefore uses Deployments for all seven components, including single-replica Recreate PostgreSQL and Redis with PVCs. A scaled Checkout pod gets a real UID and maps to the existing Checkout Deployment UID. PostgreSQL/Redis pod replacement retains data on the PVC within the same cluster; it does not provide database high availability.

KubeVerse’s traffic building IDs are `namespace/deployment-name`, for example `minishop/checkout-api`. Service names equal Deployment names. Every Pod has the same `app` selector as its Service. The [architecture manifest](architecture.json) maps source paths, deployments, Services, ports, persistent claims and known dependencies. This is a file for future integration: the existing adapter does **not** automatically import it.

## Log ingestion contract

The existing adapter discovers namespaces containing a Deployment whose **pod template** has:

```text
app.kubernetes.io/part-of=kubeverse-demo
```

It then executes the equivalent of:

```bash
kubectl --context kind-minishop -n minishop logs \
  -l app.kubernetes.io/part-of=kubeverse-demo -c workload \
  --since=5s --tail=100 --ignore-errors=true
```

Every MiniShop application and data workload uses that pod label and the container name `workload`. HTTP dependency events contain:

| Field | Meaning |
| --- | --- |
| `source` | Calling Deployment name, such as `checkout-api` |
| `target` | Actual destination hostname, such as `payment-api.minishop.svc.cluster.local` |
| `timestamp_ms` | Actual completion timestamp, Unix epoch milliseconds |
| `status` | Actual numeric HTTP response status; 503 for connection/timeout failure |
| `request_id` | Propagated action/request UUID |
| `latency_ms` | Measured call duration using a monotonic timer |
| `method`, `route` | Actual outgoing operation |
| `error` | HTTP error status or exception type when applicable |

Do not include URL schemes or ports in `target`: the adapter splits the hostname on dots, taking the first segment as Deployment and the second as namespace. It accepts bare service names in the same namespace too. It counts each observed event within five seconds, computes `rps=count/5`, and marks an edge unhealthy if any sample has `status >= 400`. Edges require both endpoints to correspond to discovered Deployments.

MiniShop’s `services/common/runtime.py` emits one client event for each real service-to-service HTTP call. Server logs use `source_service` to avoid counting both sides as separate calls. For requests received from the trusted web proxy, server logs also emit `source=minishop-web` and `target=<receiving API>`; these record the actual frontend-to-API edge. Nginx overwrites `X-Source-Service` so the public caller cannot choose that identity through the proxy.

Database/Redis dependency events are measurements around actual driver operations. They use real database hostnames from configuration, operation names and numeric status (200 on completion, 503 on driver failure). Checkout’s `orders.transaction` duration covers the real transaction scope, including HTTP coordination while its advisory lock is held; it is **not individual SQL execution time**. Business errors roll back a healthy database transaction and do not falsely mark PostgreSQL unavailable. PostgreSQL/Redis’s own unstructured server logs are ignored by the JSON parser.

Nginx emits JSON access logs with upstream address/status and duration in seconds. It does not synthesize KubeVerse timestamps. Normal API request/server logs include timestamp, request ID, service, pod hostname, method, route, status, duration and caller. Health checks are logged but have no dependency edge fields.

## Correlation, not OpenTelemetry tracing

The frontend generates a UUID for each API request. Every FastAPI request accepts a valid `X-Request-ID` or generates a fresh UUID and echoes it in the response. Internal HTTPX calls propagate the same ID and add `X-Source-Service`. All database/Redis events inside that request carry the same context-local ID. The order confirmation/error state exposes the reference for log lookup. `X-Served-By` identifies the actual serving pod in Kubernetes.

Request IDs correlate log entries across services. Kuebec uses the logged requests for live road activity and can record their latency and status in TigerData when `TIGERDATA_DATABASE_URL` is configured. [The root README](../README.md#tigerdata-network-analytics) includes the traffic generator command.

Real local browser evidence is preserved in [docs/checkout-events.jsonl](docs/checkout-events.jsonl) and [docs/checkout-database.json](docs/checkout-database.json). It was captured from independent local HTTP processes, **not Kubernetes pods**. The targets are consequently loopback hosts for those local calls. Kubernetes uses Service DNS from `k8s/01-config.yaml` instead; no evidence was relabelled to look like a cluster run.

Subsequent real-cluster verification also passed. [docs/kubernetes-checkout-events.jsonl](docs/kubernetes-checkout-events.jsonl) contains genuine pod logs, and [docs/kubernetes-integration.json](docs/kubernetes-integration.json) records ten real edges parsed by the unchanged existing `LiveCluster` adapter from a fresh checkout. This confirms backend ingestion compatibility without claiming that the separate frontend issues below were fixed.

## Run KubeVerse against MiniShop

With MiniShop deployed, launch KubeVerse’s existing backend with these environment variables from a separate terminal:

```bash
cd ../backend
KUBEVERSE_CONTEXT=kind-minishop .venv/bin/uvicorn main:app --port 8000
```

Use that backend’s existing virtual environment/setup instructions and run its frontend as usual. `kubectl` must be on the backend’s PATH and authorized to list cluster resources and read pod logs. Do not set `KUBEVERSE_MODE=sim`. A specific unavailable context raises an error instead of silently claiming to show the requested live cluster.

KubeVerse’s live controls are read-only (`require_simulator()` returns 409). Trigger scaling and pod deletion via MiniShop’s scripts/kubectl, and let the existing live watcher show the resulting changes. No KubeVerse implementation was changed to enable these controls.

To inspect one checkout:

```bash
./scripts/demo.sh logs | python3 scripts/filter-events.py REQUEST_UUID
```

Only calls actually made produce edges; an idle shop produces none. Roads are transient within the current five-second log window. Readiness/liveness probes report process/data-store health and do not turn an expected simulated payment decline into a pod crash. A real 402 payment call makes the checkout→payment road unhealthy while all pods can remain Ready.

## Existing KubeVerse live-view limitations

Source inspection found two incompatibilities outside MiniShop’s permitted edit scope:

1. `backend/live.py:LiveCluster.initial_events()` prepends a `SOURCE` event with no `object`. `frontend/src/k8s.ts:useCluster()` handles only `TRAFFIC`, `DELETED` and object events, so its current fallback dereferences `ev.object.metadata.uid` for `SOURCE`. The initial live snapshot can therefore throw instead of rendering.
2. `LiveCluster.refresh()` strips `metadata.labels` from Pods and adds `deploymentUid`. `frontend/src/City.tsx` and `frontend/src/App.tsx` still associate pods using `metadata.labels.app`; the frontend type/store does not consume `deploymentUid`. Even though MiniShop’s actual Kubernetes labels are correct, the current live stream removes them before rendering.

MiniShop cannot solve either by changing its own pod labels or logs. Correcting KubeVerse would require separately authorized edits to handle `SOURCE` and resolve pods by `deploymentUid` or preserve the pod app label. Those edits were **not made**. Resource/log format compatibility is implemented here, but end-to-end visualization in the current KubeVerse frontend is not claimed to work. The MiniShop website, direct kubectl views, logs and independent cluster demonstration do not require KubeVerse.
