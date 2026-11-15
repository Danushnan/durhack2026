# MiniShop Demo Control Centre

Dedicated integration branch: `codex/minishop-demo-control`, based on main `f5597de` (newer than origin/feature/personAandB `cba3ed9` at inspection). Road routing lives on its own branch. Only Person C's MiniShop menu concept and real traffic workflow were adapted; no experimental branch merge, `.minishop-live` files, synthetic events, KubeVerse backend changes or collector changes.

## Start locally

1. Start MiniShop normally using its existing deployment instructions. Confirm its Nginx storefront is reachable at `http://127.0.0.1:8080`. For Kubernetes, use a localhost-only port-forward of `service/minishop-web` (local 8080 to service port 8080; check the service manifest if using another deployment).
2. Create the local operator environment:

   ```bash
   python3 -m venv minishop/.venv
   minishop/.venv/bin/pip install -r minishop/demo_control/requirements.txt
   ```

    Install `kubectl` on the host. Have the cluster owner provision a least-privilege kubeconfig/context for the dedicated namespace. Optional RBAC manifest: `demo_control/rbac.yaml`; the panel never installs permissions itself.
3. Build the existing MiniShop UI:

   ```bash
   cd minishop/frontend
   npm ci
   npm run build
   ```

4. From the repository root, configure the operator (keep the token out of source control and shell transcripts):

   ```bash
   export MINISHOP_DEMO_ENABLED=1
   export MINISHOP_CONTEXT=kind-minishop # Prefer a restricted operator context
   export MINISHOP_DEMO_SHOP_URL=http://127.0.0.1:8080
   export MINISHOP_PYTHON="$PWD/minishop/.venv/bin/python"
   read -rsp 'Operator token (random, at least 24 characters): ' MINISHOP_DEMO_TOKEN
   export MINISHOP_DEMO_TOKEN
   bash minishop/scripts/operator.sh
   ```

5. Open `http://127.0.0.1:8090/#/admin`, enter the same token and Connect. Refresh verified settings to confirm the target context. Open KubeVerse alongside it (default localhost:5173; set `VITE_KUEBEC_URL` before building to change it).
6. Start traffic → introduce 2,000 ms delay → restore normal delay. Watch real measured aggregate activity in KubeVerse independently. Enable/disable payment rejection separately. Reset before finishing.

The operator serves the existing built MiniShop UI and forwards its shopping API routes through the real Nginx storefront. Normal shopping is available at `http://127.0.0.1:8090/#/`; no extra application image is required. Original MiniShop on :8080 remains unchanged. The existing Nginx configuration does **not** forward privileged demo actions. Opening the admin route on that ordinary deployment yields a visible endpoint error, not fake success. Vite development forwards `/api/demo` to :8090 and keeps its existing shopping proxies.

For CLI-only bounded activity: `python minishop/scripts/traffic.py --base http://127.0.0.1:8080 --rps 1 --count 100`. Do not run the CLI alongside the panel if you want one generator; its standalone process is outside the panel's ownership.

## API and permissions

All `/api/demo/*` routes require `MINISHOP_DEMO_ENABLED=1`, a loopback client, an allowed Host, a local Origin when supplied, and `Authorization: Bearer <MINISHOP_DEMO_TOKEN>`. Token minimum length: 24 characters. The browser retains it only in memory. No CORS permission is granted; forwarded IP headers are not trusted by the launcher. Default configuration exposes no demo endpoints. Do not bind the service to 0.0.0.0, enable proxy header trust, publish it on Vultr, or forward it through a public proxy. Public use requires separate production authentication, authorization and deployment hardening.

| Endpoint | Method | Effect |
|---|---|---|
| `/api/demo/status` | GET | In-memory traffic counters, latest operation and timestamped verified configuration; no continuous Kubernetes health polling |
| `/api/demo/traffic/start` | POST | `{rps:0.2..2, requests:5..300}`; defaults 1/s and 100. Repeated Start returns existing job rather than spawning another |
| `/api/demo/traffic/stop` | POST | Cancel and await the sole generator; repeatable |
| `/api/demo/actions` | POST | `{action:slowdown\|restore-delay\|reject\|accept\|reset\|scale\|inspect, replicas?:1..3}`; returns 202 while verification runs; overlapping operations get 409 |

Action mappings reuse `scripts/demo.sh`: slowdown → delay-payment 2000; restore-delay → delay-payment 100; reject → fail-payment; accept → restore-payment; scale → checkout-api only; inspect → read payment-api/checkout-api Deployments and minishop-config ConfigMap, resolving effective payment settings without reading secrets. Reset stops the worker and attempts delay 100, rejection off and Checkout replicas 1, even if another restoration fails. Every failed restoration is reported. A failed verification clears previously verified settings. Poll status after an accepted action; an HTTP 202 is **not success**.

Only namespace `minishop`, payment-api environment settings and checkout-api replicas are writable. No browser-provided shell, executable, namespace, context, deployment or environment name is accepted. Commands use fixed argument arrays without a shell. Pod deletion is deliberately not exposed. Optional RBAC has no pod deletion, secret access or cluster-wide permissions.

Ordinary `/api/products*`, `/api/carts/*`, `/api/checkout/*`, `/api/orders/*` are same-origin shopping proxies and carry their normal public-shopping permissions; operator bearer credentials are stripped before forwarding. No internal token or kubeconfig enters the browser.

## Bounds and semantics

One operator process/uvicorn worker owns one in-memory traffic job. Do not run multiple worker processes or operator instances. At most 2 storefront requests/s, 300 attempted requests, 20 checkout attempts, five minutes and one in-flight request. The default UI run is 100 requests. Requests browse products, add quantity one, read baskets and attempt genuine checkout; they consume real demo stock and persist orders. Reset never removes orders, baskets, database volumes or cluster resources. Repeated runs can eventually exhaust stock.

Each checkout uses a fresh idempotency key and is never automatically replayed after an ambiguous result. Stop cancels the client task, but an already received server request can finish; counts include attempted requests and confirmed HTTP/network failures, not a guarantee that every cancellation has a known outcome. Payment rejection is HTTP 402, separate from HTTP 5xx and infrastructure failure. Rollout success means readiness and configuration were read back, not that latency metrics were invented or a probe order was created. KubeVerse measures subsequent genuine traffic.

Payment experiments trigger actual Deployment rollouts, so transient readiness changes are expected. Shutdown stops traffic but does not silently reset the cluster. Use Reset explicitly. Settings and job history are in memory; after restarting, refresh verified settings. Visual Discovery reset remains entirely in KubeVerse.

## Verification

- Seven operator tests passed: auth/default-disabled/Host/Origin/IP restrictions and bounds; action serialization/verification and repeated/partial-failure resets; duplicate start/counters/stop; real payment-handler 100 → 2000 → 100 ms timing and 402 recovery; subprocess allowlist boundaries; ConfigMap-aware readback without secret exposure; generator against real HTTP MiniShop processes and disposable PostgreSQL/Redis, including genuine 200 checkout and 402 rejection.
- Existing 13 MiniShop workflow/architecture tests passed against those disposable databases, including normal shopping, persistence and payment failure. No shared cluster mutation occurred.
- MiniShop TypeScript and production build passed. KubeVerse files were untouched.
- Browser verification uses the real operator HTTP API and built UI with an intentionally unreachable storefront/nonexistent context: token entry, Start/Stop, visible connection/action failures, responsive layouts and no page errors. This does not claim a real cluster rollout test.
- Actual shared-demo Kubernetes scaling, rollout recovery and end-to-end KubeVerse latency observation require a cluster-owner-coordinated run. Backend command effects were mocked in automated tests; application payment behaviour and traffic workflows were real.

Run tests from `minishop/` after installing `requirements-dev.txt`: `python -m pytest tests/test_demo_control.py tests/test_workflows.py tests/test_architecture.py`. Existing tests need their disposable PostgreSQL/Redis setup from `scripts/test.sh`; do not point test DSNs at customer/demo data.

## Integration

Cherry-pick this branch's commit onto the latest `feature/personAandB` after preserving any local edits. These changes touch only MiniShop files and do not depend on the road integration. Review conflicts in MiniShop main.tsx/vite.config.ts with any other storefront work, then rerun the tests and build. Start with demo controls disabled; enable locally after the owner checks kubeconfig scope. Nothing is automatically merged or pushed.
