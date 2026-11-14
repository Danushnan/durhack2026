# Live MiniShop telemetry

The backend collects real pod logs once and shares validated, deduplicated
observations between rolling metrics, traffic edges and optional subscribers.
There is no database dependency for live measurements. TigerData persistence and
the simulator are unchanged.

## Run

From the repository root, using a Python environment containing
`backend/requirements.txt`:

```bash
export PATH=/tmp/minishop-bin:$PATH  # only if kubectl is installed here
cd backend
KUBEVERSE_MODE=live KUBEVERSE_CONTEXT=kind-minishop python -m uvicorn main:app --port 8000
```

Explicit live mode or an explicit context fails startup if discovery fails.
After startup, collection failures retain live mode and publish freshness/error
information; they never substitute generated requests. The legacy unset-mode
auto-discovery behavior remains: if no cluster is found, startup warns and uses
the simulator, identified by `SOURCE.context = null`.

## Person B: WebSocket contract

Subscribe to `/ws?telemetry=1` on the existing backend origin. Each WebSocket
message is still a JSON **array of events**. The initial batch contains SOURCE,
resource ADDED events, TRAFFIC, HEALTH and one SERVICE_METRICS snapshot. Subsequent
batches include full SERVICE_METRICS replacements approximately every two seconds,
even while collection is slow or failing. Resource and log workers run separately.

Plain `/ws` receives no SERVICE_METRICS events, because the existing frontend
reducer assumes unknown event types contain a Kubernetes object. The frontend
must add an explicit SERVICE_METRICS branch before opting in. Store that snapshot
separately from resource objects; **replace it, never add request counts**.
Do not let simulated TigerData HTTP results overwrite live socket metrics.

The exact machine-readable contract is [service_metrics.schema.json](service_metrics.schema.json),
JSON Schema draft 2020-12. All fields are required, including nullable fields.
`mode` is always `live`, `application` is `minishop`, and `schema_version` is 1.
No SERVICE_METRICS event is sent in simulator mode; simulator SOURCE and traffic
events remain unchanged. Live SOURCE additionally carries `mode: "live"`.

Identifiers use `namespace/deployment`, matching existing traffic endpoints:

| Service identifier (default namespace) | Measurement kind |
| --- | --- |
| `minishop/minishop-web` | `proxy_access` |
| `minishop/product-api` | `http_server` |
| `minishop/cart-api` | `http_server` |
| `minishop/checkout-api` | `http_server` |
| `minishop/payment-api` | `http_server` |
| `minishop/postgres` | `unsupported` |
| `minishop/redis` | `unsupported` |

`source_id` is `kubernetes:{context}:{namespace}`. `deployment_uid` maps to the
current resource object and can be null before discovery or after removal.
The service identifier stays stable across replica and Deployment replacement.
Each snapshot contains all seven rows. Join resources by UID or service key,
never by a pod name or request ID.

Example, with illustrative measurements:

```json
{
  "type": "SERVICE_METRICS",
  "schema_version": 1,
  "mode": "live",
  "application": "minishop",
  "source_id": "kubernetes:kind-minishop:minishop",
  "context": "kind-minishop",
  "observed_at": "2026-11-14T21:00:10+00:00",
  "window": {
    "start": "2026-11-14T21:00:00+00:00",
    "end": "2026-11-14T21:00:10+00:00",
    "seconds": 10
  },
  "source": {
    "status": "connected",
    "last_resource_refresh_at": "2026-11-14T21:00:10+00:00",
    "last_log_poll_at": "2026-11-14T21:00:10+00:00",
    "last_application_event_at": "2026-11-14T21:00:09+00:00",
    "rejected_records": 0,
    "error": null
  },
  "services": [
    {
      "service": "minishop/payment-api",
      "namespace": "minishop",
      "deployment_uid": "deployment-uid",
      "measurement_kind": "http_server",
      "request_count": 4,
      "requests_per_second": 0.4,
      "avg_latency_ms": 250,
      "p95_latency_ms": 400,
      "error_count": 1,
      "error_rate": 0.25,
      "business_rejection_count": 1,
      "business_decline_count": 1,
      "checkout": null,
      "desired_replicas": 1,
      "ready_replicas": 1,
      "infrastructure_status": "healthy",
      "application_status": "degraded",
      "availability": "active",
      "window_complete": true,
      "last_log_poll_at": "2026-11-14T21:00:10+00:00",
      "last_event_at": "2026-11-14T21:00:09+00:00"
    }
  ]
}
```

The example abbreviates `services` to one row; actual events contain seven.

### Measurements and outcomes

- Window: `(start, end]` by request **completion time**, trailing 10 seconds by default.
- Incoming Python `http_server` completions count once per receiving API.
  `/health/live` and `/health/ready` are excluded.
- Storefront counts only Nginx `proxy_access` records under `/api/`. Its measured
  `duration_seconds` is converted to milliseconds. Kubernetes supplies its missing
  application timestamp via `kubectl logs --timestamps=true`.
- Outgoing `http_client`, driver `dependency`, and legacy demo events do not
  increase incoming request counts. An HTTP call appears in each receiving service's
  metrics once; summing all service counts is not a count of unique user journeys.
- RPS is count / configured window seconds, including on startup. Averages use
  measured milliseconds; p95 is nearest rank: sorted index `ceil(.95 * N) - 1`.
- `error_count` counts **5xx** responses; `error_rate` is that count / incoming
  count, a fraction in [0,1]. `business_rejection_count` counts all 4xx responses;
  `business_decline_count` is the 402 subset. This describes response categories,
  not proof that every 4xx was an expected business decision.
- Only checkout-api has a non-null `checkout` object, when measurements are usable.
  It counts completed `POST /checkout/...` HTTP attempts, with `attempt_count`,
  `success_count` (2xx/3xx), `business_rejection_count` (4xx), `failure_count` (5xx),
  and `success_rate` (successes / attempts, or null with zero attempts).
  Idempotent HTTP retries are separate attempts, **not additional orders**.
  HTTP success does not prove a durable order; that remains MiniShop's responsibility.
- A completely observed idle window has zero counts/RPS, null latency/error rate,
  and unknown application health. Unsupported/unavailable counts are null.
  Partial windows with validated requests expose observed lower bounds and
  `window_complete: false`; partial windows without requests have null metrics.
- PostgreSQL/Redis HTTP metrics are null with `measurement_kind: unsupported` and
  `application_status: not_applicable`. Their dependency observations remain
  available, but represent caller-side operation scopes, not HTTP or SQL counts.

### Health and freshness

Infrastructure is independent of response status: healthy = enough Ready,
non-terminating workload containers; degraded = some but fewer than desired;
unavailable = none Ready with desired replicas > 0; scaled_down = desired 0;
unknown = resource unavailable/stale. A 402 never affects this classification.

For a complete, fresh window containing requests, application health degrades
at 5xx error rate >= 0.10 or p95 >= 1000 ms. Business rejections alone do not
degrade it. Display checkout success/rejection separately. Without usable
observations, health is unknown; confirmed unavailable/scaled-down infrastructure
gives application unavailable. Application status is a window summary, not a root
cause diagnosis.

Service `availability`:

| Value | Meaning |
| --- | --- |
| `active` | Collected incoming requests within a window with no known gap |
| `idle` | Reads succeed, no recent incoming requests |
| `partial` | Missing replica read, restart gap, rejected measurement or truncation |
| `stale` | Previously successful required log reads are over the freshness limit |
| `unavailable` | No successful read for this service |
| `unsupported` | No compatible incoming HTTP source |

Source `status`: connected = resource snapshot and supported service reads are
usable; degraded = stale resources or incomplete service telemetry; disconnected =
last resource query failed; unavailable = resource discovery has never succeeded.
`last_resource_refresh_at` and `last_application_event_at` are independent.
Source `last_log_poll_at` is the latest successful MiniShop pod read; per-service
`last_log_poll_at` is the oldest successful read among observed replicas. Completeness
requires **all** current replicas to have usable reads. These timestamps can differ.
`last_event_at` survives idle buffer expiry. Probe traffic does not refresh it.
`rejected_records` is a process-lifetime count of rejected read records (overlap
re-reads can reject the same malformed record again), not a request counter.

HEALTH remains `{ "type": "HEALTH", "stale": boolean, "lastRefresh": number|null }`,
where `lastRefresh` is resource refresh epoch **milliseconds**. It concerns resources,
not application traffic. A connected WebSocket alone does not establish source health.

## Person D: consume the existing collector

`LiveCluster.telemetry.subscribe(callback)` delivers immutable tuples of new
`Observation` objects **after validation and deduplication**. It returns an
unsubscribe function. Register against the active live instance; no second
Kubernetes reader is needed:

```python
from queue import SimpleQueue

pending_observations = SimpleQueue()
unsubscribe = live.telemetry.subscribe(pending_observations.put)
# Consume tuples from this queue in your persistence worker.
# At shutdown: unsubscribe()
```

Callbacks run on the log collector thread. Keep them fast; queue the batch instead
of opening database connections there. Subscriber failures are logged and isolated,
and are not retried. This is an in-process handoff, not durable storage or replay.
Subscribers receive newly accepted observations after registration, not historical
backfill. Register before starting collection if all startup events are needed.

The frozen dataclass in `live_telemetry.py` is the exact internal contract:
`event_id`, `application`, `observed_at` (Unix **seconds**), `service`, `event`,
`pod_uid`, `pod`, `container`, `runtime_timestamp`, `request_id`, `source`, `target`,
`method`, `route`, `operation`, `status`, `latency_ms`, `error`, `outcome`.
`as_dict()` returns a plain dict. Correlation IDs, route/operation and source/target
are retained. Incoming API callers may be `external`. Targets use namespace/service
keys; MiniShop Service names equal Deployment names. Proxy upstream IPs are not
guessed into a service identity. No persistence schema changes are made here.

## Collection, limits and settings

Resource discovery preserves the existing Deployment ownership resolver and
trimmed public objects. Labeled Deployment-owned pods with container `workload`
are polled individually, including non-Ready containers when logs are available.
Four concurrent pod reads are allowed. Each subprocess has the existing 15-second
deadline and Kubernetes request timeout of five seconds.

Initial reads cover window + two seconds. Successful per-pod cursors overlap by
two seconds; failed reads do not advance them. Reads are capped at 10,000 lines
per stream; reaching the cap reports partial data. The buffer is bounded by time
(at least 60 seconds), not a durable event store. Extremely large records or high
event volumes still consume proportionate memory; this is a local demo collector.

Dedup identity is pod UID + container + Kubernetes runtime timestamp + canonical
payload hash + identical-occurrence ordinal. Current/previous streams share IDs.
Request IDs are never event IDs. Replica/replacement UIDs prevent collisions.
The previous container is fetched after an observed restart, once successfully;
failed recovery is retried until old records leave the measurement window.
Multiple intervening restarts are explicitly partial because Kubernetes retains
only the latest previous container. Deleted pods and rotated logs cannot always
be recovered. An outage longer than the window recovers the current window, not
history. `window_complete` means **no known gap**, not durable exactly-once delivery.

Kubernetes has no stable log offset. Distinct byte-identical events sharing the
same runtime timestamp are intrinsically ambiguous if only part of that group is
returned. Occurrences are preserved within complete reads; capped reads are partial.
No MiniShop logging change was necessary.

| Environment variable | Default |
| --- | --- |
| `KUBEVERSE_TELEMETRY_NAMESPACE` | `minishop` |
| `KUBEVERSE_TELEMETRY_WINDOW_SECONDS` | `10` |
| `KUBEVERSE_TELEMETRY_STALE_SECONDS` | `10` |
| `KUBEVERSE_TELEMETRY_ERROR_THRESHOLD` | `0.1` |
| `KUBEVERSE_TELEMETRY_LATENCY_THRESHOLD_MS` | `1000` |

Windows/staleness/latency thresholds must be finite and positive; error threshold
is a fraction from 0 through 1. Clock skew beyond two seconds into the future is
rejected and makes the affected window partial. Out-of-order observations within
the retained window are accepted. Windows are provisional until polling catches up.

The traffic enhancements merged from main are preserved: five-second TRAFFIC
edges expose `requests`, `errors`, `error_rate`, `refused_rate` and `latency_ms` in
addition to `from`, `to`, `rps`, `healthy`. Here `healthy` means fewer than half of
observed calls were refused; HTTP error responses remain answers. These traffic
rates include 4xx outcomes and differ from the SERVICE_METRICS 5xx error rate.
Declared and previously observed roads persist with zero measured RPS when idle.
No requests are invented for those roads. The same deduplicated observations feed
traffic and service metrics, including both generic demo workload log formats.
Checkout transaction scope is excluded from PostgreSQL edge latency, preserving
the upstream distinction between transaction duration and database response time.
Use SERVICE_METRICS for independent infrastructure/application health.

## Verification

```bash
python -m pytest -q backend
```

Tests cover genuine stored pod logs through mocked kubectl resource discovery,
collection, overlap deduplication, aggregation and the actual FastAPI ASGI
WebSocket endpoint, plus replacement snapshots, plain clients, resource diffs,
replicas, malformed input, restart recovery, idle/stale states, subscriber handoff,
slow collection and the existing simulator/TigerData simulation tests.

For a running cluster with MiniShop services Ready and the shop forwarded to 8080:

```bash
kubectl --context kind-minishop -n minishop get deployments,pods
python minishop/scripts/smoke.py --base http://localhost:8080
```

Watch metrics in another terminal (websockets is included by uvicorn[standard]):

```bash
python - <<'PY'
import asyncio, json
from websockets.asyncio.client import connect
async def watch():
    async with connect('ws://localhost:8000/ws?telemetry=1') as ws:
        async for message in ws:
            for event in json.loads(message):
                if event['type'] == 'SERVICE_METRICS':
                    print(json.dumps(event, indent=2))
asyncio.run(watch())
PY
```

The smoke script uses one correlation ID across many HTTP requests and performs
an idempotent retry: do not expect just one checkout-api incoming measurement.
Compare request counts against completed server records, excluding health probes.
Repeat log polls without new traffic: counts do not increase, then expire after
the window. Leave the shop idle: request metrics become zero/null with idle state.

Coordinate these existing mutating demo controls with the MiniShop owner; they
are not run automatically by backend tests:

```bash
bash minishop/scripts/demo.sh delay-payment 2000
python minishop/scripts/smoke.py
bash minishop/scripts/demo.sh fail-payment
python minishop/scripts/smoke.py --expect-payment-failure
bash minishop/scripts/demo.sh restore-payment
bash minishop/scripts/demo.sh delay-payment 100
bash minishop/scripts/demo.sh scale 3
bash minishop/scripts/demo.sh delete-pod
```

Expected: measured latency rises; 402 increments rejections without 5xx or
infrastructure failure; successful recovery ages out old errors; replicas sum;
pod replacement does not replay old events. A temporary simulated kubectl failure
must show stale/disconnected data without switching to simulator measurements.

During implementation verification on 14 November 2026, the real kind-minishop
API was reachable with elevated read-only access, but all seven MiniShop
Deployments were scaled to zero. A temporary Uvicorn server and real WebSocket
clients verified initial/replacement SERVICE_METRICS delivery, plain-client
compatibility and actual scaled-down infrastructure state. The shared cluster
was left unchanged. Genuine stored request fixtures verify the measurement path;
a fresh real checkout, fault injection and restart against running MiniShop remain
unverified. Transport evidence was saved to
`/tmp/kubeverse-live-transport-verification.json` (temporary local artifact).
