# Final integration

Integration branch: `integration/final-merge`.
Inputs verified after `git fetch --all --prune` on 2026-11-15:

- `main` / `origin/main`: `71b88d39fe45641c7cbdfacdbb4dcfe2e4017dc1`.
- `codex/discovery-activity-and-playback`: `d7868653faa47d872136d92612a15fdc8632064c`.
- Common ancestor: `334adc815e5905df6e04c19896f59dd1554da78e`.

## Conflict resolution

Only `frontend/src/City.tsx` had textual conflicts (five regions).

1. Combined Traffic's Discovery/source/selection props with an explicit
   `previewRefused` flag. Real outcomes use measured error/refusal shares;
   readiness never overrides them. Synthetic previews only fail when explicitly
   requested by the operator, independently of resource readiness in the renderer.
2. Retained both the failure-burst timer and Discovery activity-period state.
3. Combined source/geometry cleanup of cars, admission credit, activity state and
   burst timer. Pause clears in-flight state. Discovery reset clears that state
   and abandons queued previews, while new preview requests still work. Socket
   disconnect clears the preview queue; a reconnect/source snapshot clears it too.
4. Kept the burst component inside the selection-controlled visibility group.
   Pause hides that entire group. Demo previews receive the same relationship
   selection rule as real traffic, and both pause when telemetry is unavailable.
5. Combined the live call's Discovery density, source and selection controls with
   main's burst-capable renderer. Removed its binary pod-readiness outcome
   override. Pod health remains visible independently on buildings/inspectors.

Journey education, Checkout request correlation and instrumentation, gold guide,
follow camera, adjustable speed, replay and shared-road/roundabout geometry are
retained. Main's bursts, red return vehicles, synthetic refusal endpoint/events,
operator readiness verification, 20/s option and bounded traffic controls remain.

`failed` counts all unsuccessful storefront attempts. The additional `refused`
counter counts the subset followed by a zero-Ready-pod check. This check happens
later and cannot establish a precise request's root cause. HTTP 402, other HTTP
error replies and communication failures remain distinct in measured data and
Journey explanations, even though their animated return vehicles are all red.
Synthetic events are broadcast only to illustration consumers; they never enter
TRAFFIC measurements, Journey observations, service-health calculations or the
PostgreSQL history subscriber.

## Canonical source/build paths

- City frontend: `frontend/src/`; build in `frontend/` with `npm run build`;
  output is `frontend/dist/`.
- City API/collector/history: `backend/`; start from this directory with
  `python -m uvicorn main:app`. Set source/history environment variables explicitly
  for a future deployment; verification did not start it against shared services.
- MiniShop frontend: `minishop/frontend/src/`; build in `minishop/frontend/`
  with `npm run build`; output is `minishop/frontend/dist/`.
- MiniShop services: `minishop/services/` and `minishop/common/`.
- Operator: `minishop/demo_control/`; its existing launcher is
  `minishop/scripts/operator.sh` (starts an opt-in operator that can mutate a
  cluster; it was not launched during verification).
- Container build contexts: `minishop/`, using `services/Dockerfile` and
  `frontend/Dockerfile`, as referenced by `minishop/scripts/build-images.sh`.

All tracked `.minishop-live` files are preserved exactly as on main. They contain
source copies and old restart builds, and must not be used as canonical inputs.
No existing running application or deployment was redirected or restarted.

## Verification

Tests use mocked dependencies or newly created, disposable PostgreSQL 17/Redis 8
containers on randomly allocated loopback ports. No shared cluster/database was
modified. Test Python dependencies were installed only into a temporary virtualenv.

- Backend: all 116 tests passed, including real PostgreSQL history writes,
  deduplication/restart reads, outage behavior, basket/Checkout reconstruction,
  declines, slow payment, saved-order reuse, cleanup failure and source isolation.
  This includes the 2 new synthetic-event isolation/access tests.
- MiniShop: all 22 tests passed against disposable stores and real local HTTP
  service processes. Coverage includes actual payment success, 2-second delay,
  HTTP 402 decline, rollback, idempotency, request-ID propagation, persistence,
  communication failure and mocked operator commands.
- City frontend: all 45 individual tests passed with Node's
  `--test --test-isolation=none tests/*.test.ts`. Covers shared roads, Discovery,
  bursts/return phases, measured versus synthetic outcomes, source/reconnect
  behavior, monitoring and Journey protocol.
- MiniShop frontend registration test passed, including independent basket and
  Checkout request IDs and opener pairing.
- Both frontend TypeScript checks and production builds passed. City build
  retains the large-bundle warning (approximately 1.35 MB before gzip).
- Oxlint exited successfully with warnings about existing React/Three ref and
  camera mutation patterns, effects/dependencies and Fast Refresh exports;
  the new reset effect also follows the imperative ref pattern.

The isolated browser smoke test is `frontend/tests/integration.browser.mjs`.
It serves the production city build on an ephemeral loopback port and mocks all
HTTP/WebSocket evidence; it never contacts an application backend, cluster or
store. `integration-fixtures.py` derives responses from the backend's real
reconstruction code and existing test observations. Set `TEST_PYTHON` to a Python
with backend test dependencies; set `PLAYWRIGHT_MODULE` and `CHROME_PATH` when
Playwright/Chromium are not installed in their standard locations. Optional
`CAPTURE_SCREENSHOTS=1` writes screenshots under `/tmp`.

The final browser run passed in approximately 58 seconds, with six registration
messages, two WebSocket connections and no page errors. It exercises Discovery
selection, synthetic preview delivery,
basket/Checkout/decline explanation panels, speed controls, replay without new
action registrations, canvas retention, Discovery reset, reconnect, source change
and no horizontal overflow at 320/768/1024/1440px. It does not establish pixel-level
correctness of every particle frame or physical gold-car speed. Those details,
and full deployed-browser-to-Kubernetes-to-history behavior, require a later
explicit live smoke test. Existing live browser scripts were not run because
they submit shopping operations to their configured application servers.

Initial test attempts encountered missing temporary Python dependencies and
sandbox socket restrictions; both were resolved. A counter assertion and mocked
browser registration/source fixtures were corrected before final verification.
