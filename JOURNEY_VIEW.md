# Add to Basket Journey View

This records the original Add to Basket milestone. Current educational content and Checkout support are documented in [JOURNEY_EDUCATION.md](JOURNEY_EDUCATION.md).

Implemented on `codex/add-to-basket-journey`, based on verified integration baseline
`015c9d0` (`cumit`). That baseline already contains Discovery, shared street geometry,
functional roundabout lane paths, live monitoring, history, and demo controls. No
other branches were merged. The original working tree was clean.

## Scope and files

- `minishop/frontend/src/journey.ts`: explicit paired-window action reporting.
- `minishop/frontend/src/api.ts`, `App.tsx`: one action UUID, two distinct HTTP
  request UUIDs per Add to Basket; independent mutation/refresh browser outcomes.
- `minishop/frontend/vite.config.ts`: optional `MINISHOP_API` gateway proxy for
  testing the current UI against deployed services; original local service proxies
  and demo-control route remain available.
- `backend/journeys.py`, `backend/main.py`: opt-in registration and short polling.
- `backend/live_telemetry.py`: locked, bounded read of validated request observations.
- `frontend/src/Journey.tsx`, `journeyProtocol.ts`,
  `App.tsx`, `City.tsx`, `index.css`: pairing, action selection, stage playback,
  technical details, participating-building rings, one separate gold guide, and
  Traffic/Journey controls. Architecture button removed; Discovery starts by default
  for a live MiniShop source. Simulator behavior remains separate.
- Focused backend, browser-protocol, MiniShop action, and opt-in browser tests.

The collector, WebSocket messages, traffic rates, infrastructure/application health,
PostgreSQL history subscriber, and demo control implementation are unchanged.
Architecture layout data still builds the stable city; the Architecture **button**
has been removed as requested. Discovery remains independently resettable.

## Action association and deployment path

Open MiniShop using **Journey → Open paired MiniShop**. Its URL receives only the
KubeVerse origin. MiniShop sends reviewed action metadata to its opener using
`postMessage` with an explicit target origin. KubeVerse accepts messages only from
that exact opened window and configured shop origin, validates the payload, and
registers it through its own same-origin `/api` proxy. No cross-origin HTTP access,
new service, Nginx journey route, customer payload, product name, or basket/session
identifier is needed. Nginx CSP permits this window messaging path; it does not
require `connect-src` changes.

Registration is acknowledged before the POST, with a 1.5-second fallback so an
unavailable journey backend cannot prevent shopping. The two preallocated UUIDs
are passed explicitly to the existing HTTP helper and preserved by the existing
Nginx/backend correlation mechanism. A rejected mutation does not send a refresh;
its reserved refresh ID is marked `not_sent`. Browser success/failure reports are
separate from collected backend facts. Viewer bearer capabilities live only in
KubeVerse window memory; the MiniShop window never receives that capability.

Pairing must be initiated from KubeVerse, and both updated frontends must be served.
An already-open old storefront image cannot report actions. Closing/reloading
KubeVerse loses this temporary pairing; open a new paired shop. A browser that
severs `window.opener` through an external COOP policy will require a different
pairing transport; that policy is not present in the inspected demo Nginx config.

## Evidence and truthful explanations

`POST /api/journeys/actions` registers immutable action/request associations and
monotonic browser outcomes. `GET /api/journeys/{action_id}` reads only that viewer's
action. Both require `KUBEVERSE_JOURNEYS=1`, a viewer bearer UUID, and a live collector.
Use this only on a trusted loopback demo backend, not as public authenticated hosting.

Evidence comes from Person A's validated in-memory Observation records, never
TRAFFIC or SQL history. Selection checks application, namespace, exact request IDs,
collection interval, and collector object identity. Event IDs and original
observation identity are retained. Namespace/context identify the source; a
collector-session UUID accompanies responses. Reconnecting to the same collector
retains the action; switching source or restarting collection requires new pairing.

Registration accepts up to five seconds of pre-registration completions to cover
relay timing. Collection lasts 30 seconds, with a final poll snapshot; results are
frozen afterward. Completed events retain their own observed times, status,
duration, operation and outcome. Deduplication uses event IDs. Multiple Cart roots,
unexpected browser-facing roots, different mutation/refresh basket routes, reused
request assignments, and changed associations are rejected or marked ambiguous.
Ambiguous evidence never draws a guide dependency. Routes redact UUID identifiers.
Limits are 128 events per action, 20 actions per viewer, 100 total, five-minute
expiry. Capacity limits return 429; expiry returns 404. This is a polling-oriented
local demo facility, with no persistent replay or guaranteed collection if the
viewer stops polling for longer than the collector's observation retention.

The nine explanations are fixed reviewed templates:

1. Browser → Cart mutation: observed Cart POST root, source MiniShop web.
2. Cart → Product: observed outgoing GET for one product.
3. Product → PostgreSQL: observed `products.select_one` dependency.
4. Cart → Redis: observed `basket.mutate`; the wrapper does **not** establish acceptance.
5. Mutation result: observed root POST status; only a successful root confirms acceptance.
6. Browser → Cart refresh: separate observed GET root and separate request ID.
7. Cart → Redis: observed `basket.get`.
8. Cart → Product: observed outgoing GET `/products` for display data.
9. Display updated: explicitly labeled browser report, separate from backend evidence.

No service operation is invented when its observation is missing. Pending, partial,
failed and ambiguous states are explicit. Parent operation durations are never
added to child durations. The dependency names/roles are curated educational
interpretation of observed operations; causal identity within each request relies
on its explicitly assigned propagated request ID, not span-level tracing. No claim
is made about item name, quantity or payload. Checkout and payment education are
deferred to preserve the deadline-sized P0 implementation.

## Marker and city integration

The gold octahedron is one guide for an action involving multiple requests. It
samples the existing `StreetRoute.outbound` polyline with the existing `Path`
helper, preserving roundabout paths. Only evidenced caller/callee stages get a
road guide. Source/destination rings show the current relationship; subtler rings
show participants. Changing branches starts from that stage's actual caller;
there is no PostgreSQL → Redis route. Result/display stages use a stationary marker
at the relevant building; unavailable stages draw no marker. Timing is a fixed
three-second teaching animation, not measured latency.

Cars are hidden using a separate group's visibility; their frame updates and
telemetry continue. The Canvas, road network, selection and camera are retained.
Animation uses refs and `useFrame`, not per-frame React state. Previous/Next/Replay
only control playback and never issue shopping requests. The monitoring summary is
hidden while the narrow-screen journey panel is open; Traffic restores it. The
journey panel scrolls independently on short screens.

## Exact local demonstration

When running the [Demo Control Centre](minishop/OPERATOR.md) with a current operator build, Journey defaults to its storefront at `http://127.0.0.1:8090/`. Start the live KubeVerse backend with `KUBEVERSE_JOURNEYS=1`, then open Journey and select **Open paired MiniShop**. The operator storefront proxies real requests to MiniShop on port 8080 and reports paired Add to Basket actions to the city.

From the repository root, leave the existing Kubernetes cluster running. These
steps use separate ports for an isolated run without the operator.

```bash
# Terminal 1: only if the existing MiniShop forward on 8080 is not running
kubectl --context kind-minishop -n minishop port-forward --address 127.0.0.1 service/minishop-web 8080:8080

# Terminal 2
cd backend
KUBEVERSE_CONTEXT=kind-minishop KUBEVERSE_MODE=live KUBEVERSE_JOURNEYS=1 python -m uvicorn main:app --host 127.0.0.1 --port 8011

# Terminal 3, from repository root
cd frontend
KUBEVERSE_API=http://127.0.0.1:8011 npx vite --host 127.0.0.1 --port 5181 --strictPort

# Terminal 4, from repository root
cd minishop/frontend
MINISHOP_API=http://127.0.0.1:8080 npx vite --host 127.0.0.1 --port 5182 --strictPort
```

Dependencies must already be installed (`backend/requirements.txt`, both frontend
package-lock files). In this session the Python runtime was
`/tmp/kubeverse-person-b-venv/bin/python`, kubectl was
`/tmp/kubeverse-person-b-bin/kubectl`, and Node was
`/home/arnav/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node`.
Those local runtime paths are environment-specific, not deployment requirements.

1. Open `http://127.0.0.1:5181`. Discovery is selected automatically.
2. Click Journey, set MiniShop URL to `http://127.0.0.1:5182`, then Open paired MiniShop.
3. Arrange the two windows side by side. Click Add to basket once.
4. Wait for real collector events (typically several seconds). Inspect the separate
   mutation acceptance and browser-refresh report.
5. Advance through the guide, expand event details, and replay it. Replay does not
   touch the basket. Traffic restores aggregate cars. Reset Discovery remains independent.
6. A new Add to Basket selects a new action; use the action selector to inspect an earlier one.

For a deployed static shop frontend, build and deploy these MiniShop source changes
through the normal image workflow later. This implementation was verified using
updated local frontends through the existing Kubernetes Nginx gateway; the shared
cluster frontend image was not rebuilt or replaced.

## Verification and merge

Validation results and limitations are recorded in the delivery response. Browser
checks are opt-in because they create real demo basket mutations (no checkout or
orders). See `frontend/tests/journey.browser.mjs` and
`frontend/tests/journey.scenarios.mjs`; they expect the isolated ports above and a
Playwright installation. Set `PLAYWRIGHT_MODULE` to its module path when not
installed locally. No tests change Kubernetes configuration.

Review the diff and rerun the focused tests before merging. Do not merge another
routing branch: its integrated implementation is already in this baseline.

```bash
git diff main...codex/add-to-basket-journey
git switch main
git pull --ff-only
git merge --no-ff codex/add-to-basket-journey
```

If main has advanced and conflicts occur, review and resolve them on the feature
branch and rerun checks first. Keep the journey backend opt-in until both updated
frontends are available. No automatic push, merge, cluster deployment, or history
migration is part of this change.

### Recorded validation

- Backend: **98 passed, 1 skipped** (optional real history database test).
  This environment required an isolated temporary `httpx2` install for the
  installed Starlette TestClient. No application dependency versions were changed.
- Existing frontend traffic, Discovery and live-metrics tests plus the journey
  protocol test: **4 test files passed**.
- MiniShop action-association test: **passed**; sequential and concurrent actions
  allocate independent UUID pairs and report only the approved metadata.
- Both frontend TypeScript checks and Vite production builds: **passed**.
  KubeVerse retains its existing large-chunk build warning. Focused lint completed
  with React advisory warnings, including pre-existing City patterns; no lint errors.
- Real Chromium and `kind-minishop`: Add to Basket completed with **two distinct
  browser request IDs and 12 actual observations**. All nine guide stages, replay
  without requests, retained Canvas, camera reset/mode controls, and responsive
  layout were exercised. No browser page errors occurred.
- Two independently paired concurrent viewers stayed isolated. Background catalogue
  traffic was excluded. Successful real mutation plus an intentionally aborted
  browser refresh remained mutation-accepted/refresh-failed, with no invented GET
  observations. A real HTTP 422 rejected mutation produced no successful-mutation
  claim and marked refresh not sent. These tests created demo basket actions only.
- Existing MiniShop integration tests: **6 passed**, then setup stopped because the
  dedicated PostgreSQL test server at `127.0.0.1:55432` was unavailable. The full
  local PostgreSQL/Redis workflow suite is therefore not claimed as passing.
- No shared cluster configuration, deployed image, payment setting, or order was
  modified for verification. The isolated local journey servers were used alongside
  the existing MiniShop gateway forward.

Repeat the focused checks with installed runtimes:

```bash
python -m pytest -q backend
(cd frontend && npm test && npm run build)
(cd minishop/frontend && npm run test:journey && npm run build)
# Optional real-browser checks, while the isolated servers above are running:
node frontend/tests/journey.browser.mjs
node frontend/tests/journey.scenarios.mjs
```

The browser scripts use Playwright's default Chromium unless `CHROME_PATH` is set.
They save verification screenshots/evidence under `/tmp`. Do not run them against
an unrelated production shopping environment.
