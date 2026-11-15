# Live MiniShop monitoring

The existing city subscribes to `/ws?telemetry=1`. `watch.ts` validates event arrays,
handles `SERVICE_METRICS` explicitly, and replaces the complete snapshot independently
of Kubernetes resources. `liveMetrics.ts` follows `backend/service_metrics.schema.json`.
Invalid snapshots retain the last valid data and show a warning. Unknown event types
are ignored rather than interpreted as Kubernetes resources.

Service identity is `namespace/deployment`; an available Deployment UID must match.
Pod names and request IDs are never used as service identities. All seven MiniShop
components are supported. PostgreSQL and Redis show infrastructure health with
unsupported HTTP metrics, not zero RPS/latency.

## What the city means

- Building application health comes from backend `application_status`, independent
  of pod colours/readiness. The frontend does not apply simulator thresholds to it.
- Idle application health is unknown. Partial values are observed lower bounds.
  Unavailable values stay null and render as an em dash.
- HTTP 5xx and HTTP 4xx/402 outcomes are separate. A payment decline alone does not
  classify a workload as failed. Checkout rates describe completed HTTP attempts,
  including retries, not durable orders.
- Overview totals count incoming service completions, including multiple services
  participating in one journey. Mean latency is request-count weighted over measured
  services. The highest service p95 is explicitly not a combined p95.
- Roads use the backend's existing declared/previously observed topology, retained
  while idle. Road response errors include 4xx/5xx and have different semantics and
  a five-second window; service metrics have the snapshot's reported window.
- Cars, waiting, travel times and pod flashes illustrate aggregate activity. They
  are not traces, measured per-request routing, or root-cause diagnoses.
  Live animation density is normalised for quieter manual shopping activity;
  simulator density and the existing per-road rendering pool are unchanged.
- Selection highlights directly connected components. Potential impact does not
  assign a failure to another component without its own observations.

The connection indicator describes the WebSocket, while source status describes
collection health. After ten seconds without a valid service snapshot, the client
labels it stale; this transport watchdog is separate from the backend's configurable
log freshness policy. Disconnect retains labelled last-known measurements and pauses
traffic. Reconnect replaces the resource inventory atomically on the initial SOURCE
batch. Same-source selection persists and equivalent topology retains its layout;
source changes clear selection and
live/simulator measurements cannot be combined.

Undeployed component placeholders and additional layout work are deferred. Existing
deployed buildings and persistent backend roads remain the topology source.

## Demonstrate slowdown and recovery

Have the MiniShop owner start the seven workloads and forward the storefront before
judging. The frontend does not change the cluster or inject faults.

1. Start the existing backend from `backend/` with its Python environment:
   `KUBEVERSE_MODE=live KUBEVERSE_CONTEXT=kind-minishop python -m uvicorn main:app --port 8000`.
   Start `npm run dev` from `frontend/`. The default Vite proxy targets port 8000;
   `KUBEVERSE_API` can select an isolated backend.
2. Forward MiniShop: `kubectl --context kind-minishop -n minishop port-forward service/minishop-web 8080:8080`.
   Browse the shop, add products and check out. Select `payment-api` (the Bank).
   Allow collection to establish a complete window; inspect source and completeness.
3. From the repository root, have the incident operator run
   `bash minishop/scripts/demo.sh delay-payment 2000`. Generate completed checkouts
   through the shop or `python minishop/scripts/smoke.py --base http://localhost:8080`.
   After collection/rollout settles, the backend should report degraded application
   health and measured high p95 while Kubernetes readiness remains independent.
4. Run `bash minishop/scripts/demo.sh delay-payment 100` and generate more requests.
   Old slow completions age out of the rolling window (default ten seconds), then
   the backend's healthy classification returns the building to normal.
5. Separately, `bash minishop/scripts/demo.sh fail-payment` produces HTTP **402**,
   not 5xx. Observe declines and checkout outcomes. Restore with
   `bash minishop/scripts/demo.sh restore-payment`. Restore delay separately if set.

The scripts update environment variables through Kubernetes rollouts, so temporary
partial coverage during pod replacement is expected. The existing scripts do not
provide a deliberate server-5xx scenario; coordinate that demonstration with Person C.

## Person D: historical integration boundary

`Telemetry.tsx` remains the existing simulated TigerData history/replay interface.
Its requests and city overlays are enabled only for a confirmed simulator SOURCE.
Live MiniShop snapshots never use those results. No replay API or ingestion code
was changed and there is no second replay system.

Before real history can drive the city, agree on source/application identity,
measurement/window timestamps, nullable fields, measurement kinds, 5xx versus
4xx/402 semantics, checkout attempt semantics, and completeness. Historical p95
must be supplied or derived from original observations, never averaged from p95s.
Historical resource state must also be identified separately from current resources.

## Verification

From `frontend/`: `npm test`, `npm run lint`, and `npm run build` (includes TypeScript
checks for the app and Vite configuration). For individual Node test reporting,
`node --test --test-isolation=none tests/*.test.ts` runs the same suite.

Focused regression tests cover validation, replacement, mixed event compatibility,
identity changes, independent health, 402/5xx, idle/partial/stale/disconnected states,
recovery, unsupported stores and aggregate arithmetic. Existing traffic/layout tests
remain in place. Browser checks additionally exercise the inspector, visible Bank
alarm, source isolation, reconnect selection and narrow layouts.

Verified on 14 November 2026: 21 Node regression tests passed; TypeScript and the
production build passed. Lint exited successfully with the existing seven warnings;
the production build retains the existing large-chunk warning. Controlled browser
fixtures verified healthy/slow/5xx/402/idle/recovery states, source switching,
disconnection and reconnect selection. Real initial and replacement WebSocket
snapshots updated the Payments Bank and all seven service inspectors, with camera
controls and panel visibility checked at 320, 768, 1024 and 1440 pixel widths.

All seven real MiniShop Deployments were scaled to zero during verification. Their
actual scaled-down readiness, unavailable application health and null HTTP values
were verified; no cluster settings were changed. A real shopping slowdown/recovery
still needs running MiniShop workloads. Those performance states were verified with
controlled frontend fixtures, not claimed as a completed real checkout demo.
