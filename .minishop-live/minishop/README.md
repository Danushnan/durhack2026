# MiniShop

A small, real e-commerce application for KubeVerse’s Composition demonstration. React, four independent FastAPI services, PostgreSQL products and orders, and Redis baskets. Payments are explicitly simulated: no card details, real charges, fulfilment or user accounts.

MiniShop is entirely self-contained in this directory. No existing KubeVerse files were changed. `minishop/` is nested in the checkout because the workspace permits writes here, rather than in its parent.

![MiniShop storefront](docs/storefront.jpg)

## Start with Docker Compose

Prerequisites: Docker Engine/Desktop with Compose v2 and about 2 GB available RAM. Run every command below from `minishop/`.

```bash
cp .env.example .env
bash scripts/compose-up.sh
python3 scripts/smoke.py
```

Open **http://localhost:8080**. The browser talks only to the web reverse proxy; databases and APIs have no published host ports. Compose waits for PostgreSQL, runs the migration/seed service, then starts the application. Initial image downloads need internet; product photos are bundled locally.

```bash
docker compose ps
docker compose logs -f checkout-api cart-api product-api payment-api
docker compose down                 # named volumes retain orders and baskets
docker compose up -d --wait         # resume with the same data
```

For a deliberate decline in Compose:

```bash
PAYMENT_FAIL=true docker compose up -d --no-deps --force-recreate payment-api
python3 scripts/smoke.py --expect-payment-failure
PAYMENT_FAIL=false docker compose up -d --no-deps --force-recreate payment-api
```

Compose supports `docker compose up -d --scale checkout-api=3`. There are no fixed container names or backend host ports. Nginx resolves service names again as their addresses change. Kubernetes scaling remains the primary judging workflow.

## Start on kind

Prerequisites: a working Docker daemon, `kind`, `kubectl`, Bash, Python 3 for the smoke test, and roughly 3 GB available RAM. No ingress controller or cloud services are needed. `scripts/kind-up.sh` is the single build/load/deploy path:

```bash
./scripts/kind-up.sh
kubectl --context kind-minishop -n minishop port-forward service/minishop-web 8080:8080
```

Leave the port-forward running; open **http://localhost:8080**. In another terminal:

```bash
python3 scripts/smoke.py
kubectl --context kind-minishop -n minishop get deployments,pods,services,pvc
./scripts/verify-k8s.sh
```

The verification script makes real HTTP requests, checks checkout, scales to three serving replicas, deletes one pod, checks replacement/readiness, introduces HTTP 402 payment failures, and restores successful checkout. It resets failure/delay settings and the replica count on exit. It assumes localhost:8080 already forwards the frontend Service.

`kind.yaml` creates a control-plane and worker. kind’s default local storage provisioner supplies the two PVCs. PostgreSQL and Redis use single-replica `Recreate` Deployments so the existing KubeVerse adapter can follow Deployment → ReplicaSet → Pod ownership for every component. These data stores are persistent but not highly available.

All app containers are named `workload`. Pod labels include `app`, `app.kubernetes.io/name`, `app.kubernetes.io/component`, and `app.kubernetes.io/part-of=kubeverse-demo`. The latter value is intentionally KubeVerse’s existing discovery contract, not a typo for `minishop`.

The script operates on the explicit context `kind-minishop` and namespace `minishop`. Override the cluster name with `MINISHOP_CLUSTER=your-name`. Image loading includes a platform-specific fallback for Docker 29’s containerd image store with older kind. API pods use `ndots:1` to resolve internal Service names before inherited external search domains; Nginx uses fully qualified cluster upstreams. For an existing non-kind cluster, build/publish or load the five images yourself, then use `./scripts/deploy.sh your-context`; the cluster needs a default storage class. Set `MINISHOP_CONTEXT=your-context` when using the demo/reset/verification scripts.

After code edits, rerun `./scripts/kind-up.sh`. This rebuilds and loads the images, reruns checksummed migrations, and restarts application Deployments to pick up the rebuilt `:demo` tags. Deploying reapplies the baseline one-replica, healthy payment configuration.

`k8s/01-config.yaml` includes **public local-demo credentials** for an immediate demo. Set matching `POSTGRES_PASSWORD`, `DATABASE_URL` and `INTERNAL_TOKEN` values there before using a shared environment. Compose reads `.env` separately. Use URL-safe database passwords or percent-encode them in database URLs. Services use one demo database role; this is not a hardened internet-facing deployment.

## What runs

| Source | Deployment / Compose service | Responsibility | Storage / calls |
| --- | --- | --- | --- |
| `frontend/` | `minishop-web` | React shop + Nginx stable routing | Product, Cart, Checkout APIs |
| `services/products/` | `product-api` | Catalogue, prices, availability | PostgreSQL |
| `services/cart/` | `cart-api` | Guest baskets, atomic edits, checkout freeze | Redis, Product API |
| `services/checkout/` | `checkout-api` | Checkout coordination, order history | Cart, Product, Payment APIs; PostgreSQL |
| `services/payments/` | `payment-api` | Simulated provider with delay/decline modes | No money or external processor |
| `db/` | `postgres` | Products, orders, order items, payment references | `postgres-data` PVC |
| `services/cart/` (data contract) | `redis` | Basket JSON, versions, checkout freezes | `redis-data` PVC, AOF |

See [architecture.json](architecture.json) for machine-readable dependencies and [INTEGRATION.md](INTEGRATION.md) for the exact KubeVerse contract.

## Checkout and persistence

1. The browser stores a random guest session UUID in local storage. Redis stores its basket for seven days after creation or mutation. No prices from the browser are accepted.
2. The browser persists an `Idempotency-Key` UUID before submitting checkout, and keeps it for retries after failures or unknown outcomes.
3. Checkout obtains a PostgreSQL transaction advisory lock for the session. Another replica receives HTTP 409 while that session is being checked out. A unique `(session_id, idempotency_key)` constraint protects persisted orders.
4. Cart atomically freezes the basket in Redis for at most 120 seconds and returns its version. Edits return HTTP 409 while frozen. Checkout’s overall deadline is 45 seconds; dependency calls have 10-second timeouts and 2-second connection timeouts.
5. Checkout retrieves trusted product data via HTTP, validates availability, calculates integer-pence totals and calls the independent Payment API.
6. Only a successful simulated payment causes the order and its line-item snapshots to be inserted and committed together. Declines, upstream failures and database errors create no completed order.
7. After commit, Cart clears only the version checked out. Replaying an old successful checkout cannot clear a newer basket. If cleanup is unavailable, checkout still returns the durable confirmation with `basket_cleared=false`; the UI offers a safe retry using the same key. An expired freeze releases a basket after a pod crash.

PostgreSQL schema changes are ordered SQL files in `db/migrations/`, applied by `python -m db.migrate`. Migration names/checksums are stored in `schema_migrations`; a PostgreSQL lock serializes migration runners. Changing an applied migration raises an error. Add a new numbered SQL file for future changes. Migration and seed run in one transaction. Seeding ten products is idempotent and does not overwrite existing product records or prices.

The catalogue’s `stock` is an availability limit per basket/order. This demo does not decrement global inventory or implement reservations. Prices and product names are copied into order items, preserving historical totals after catalogue edits. Orders live until explicitly removed; service restarts and pod replacement do not delete them. PVCs do not survive deleting the kind cluster, and there are no backups.

The guest UUID is a bearer identifier, not authentication. Anyone who learns it can inspect that session’s basket and orders. Clearing browser storage loses the session reference, not the server data. A new private window is an easy fresh judging session. Never enter personal or card information; the checkout has no such fields.

The payment provider returns deterministic `sim_…` references for a session/key/amount/currency, with no financial ledger. This makes simulated retries safe but does not provide a commercial payment reconciliation or refund protocol. The workflow is not a distributed transaction; a real processor would require durable payment attempts and reconciliation if a pod dies between payment and order commit.

## API reference

FastAPI OpenAPI docs are available on each backend’s `/docs` when port-forwarded directly for development. Public browser routes are:

| Method | Proxy path | Meaning |
| --- | --- | --- |
| GET | `/api/products` | PostgreSQL catalogue |
| GET | `/api/products/{product_id}` | Product details |
| GET | `/api/carts/{session_id}` | Retrieve/create guest basket and trusted totals |
| POST | `/api/carts/{session_id}/items` | Add `{ "product_id": "UUID", "quantity": 1 }` |
| PUT | `/api/carts/{session_id}/items/{product_id}` | Set `{ "quantity": 2 }` |
| DELETE | `/api/carts/{session_id}/items/{product_id}` | Remove a line |
| POST | `/api/checkout/{session_id}` | Place order; required `Idempotency-Key: UUID` header |
| GET | `/api/orders/{session_id}` | Latest 50 orders for that session |

Every service has `/health/live` and `/health/ready`. Product/Checkout readiness checks the database and schema; Cart readiness checks Redis. Payment stays Ready when configured to decline, deliberately separating application success from infrastructure health.

Cart’s `/internal/carts/{session_id}/snapshot` and `/finish`, and Payment’s `/payments`, require `X-Internal-Token`. Nginx does not expose these routes. Quantity bounds are 1–99 and availability is checked server-side. Unknown products return 404; invalid input 422; empty/busy baskets or insufficient availability 409; simulated declines 402; unavailable dependencies/data stores 503; overall checkout deadlines 504.

## Tests and local source development

For real PostgreSQL/Redis integration tests:

```bash
./scripts/test.sh
```

This exposes the Compose databases on loopback 55432/56379, creates `minishop_test`, installs a Python virtual environment, and starts independent API processes during pytest. Tests use Redis database 15 and randomized guest IDs. If you changed the Compose password, provide a matching `TEST_DATABASE_URL`. Do not point the suite at a valuable database: it temporarily edits one catalogue description to prove PostgreSQL retrieval.

If PostgreSQL and Redis already run locally:

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
TEST_DATABASE_URL=postgresql://minishop:password@127.0.0.1:5432/minishop_test \
TEST_REDIS_URL=redis://127.0.0.1:6379/15 .venv/bin/python -m pytest -q
```

The suite covers actual database retrieval, Redis state/updates, health, successful checkout, a real HTTP 402 decline, a real connection refusal, persisted orders across process replacement, concurrent idempotency across independent checkout processes, basket freezing, safe replay after new basket edits, request correlation and deployment/architecture contracts. No fake database or mock HTTP transport is used.

Frontend build (Node 22.12+ and npm):

```bash
cd frontend
npm ci
npm run build
```

For hot reload, run the APIs with Uvicorn on ports Product=8001, Cart=8002, Checkout=8003, Payment=8004; set `DATABASE_URL`, `REDIS_URL`, `INTERNAL_TOKEN`, `PRODUCT_URL=http://127.0.0.1:8001`, `CART_URL=http://127.0.0.1:8002`, and `PAYMENT_URL=http://127.0.0.1:8004` in those terminals. Run `.venv/bin/python -m db.migrate` first, then `.venv/bin/uvicorn services.products.app:app --port 8001` (and the corresponding `cart`, `checkout`, `payments` modules). In `frontend/`, `npm run dev` serves http://localhost:5173 with Vite proxy routing matching Nginx’s public API paths.

## Troubleshooting

| Symptom | Check / fix |
| --- | --- |
| Docker cannot connect | Start Docker Desktop/Engine; `docker info` must succeed. |
| Browser port already in use | Stop an older Compose/port-forward, or use `8081:8080` in the port-forward and `--base http://localhost:8081` for smoke tests. |
| API not Ready / schema missing | `kubectl --context kind-minishop -n minishop logs job/minishop-migrate`; inspect PostgreSQL logs; rerun `scripts/deploy.sh` after fixing the cause. |
| `ImagePullBackOff` | Rerun `scripts/kind-up.sh`; verify local `:demo` images loaded into the correct named cluster. |
| PVC Pending | `kubectl --context kind-minishop get storageclass`; kind should have a default provisioner. |
| Expected payment decline | `./scripts/demo.sh restore-payment`; then retry the same checkout. |
| Checkout busy after a killed pod | Wait at most 120 seconds for the Redis freeze; retry the same key. |
| Order saved, basket cleanup pending | Use the confirmation’s safe retry after Cart/Redis recovers. Do not create a new checkout key for that uncertain attempt. |
| KubeVerse shows simulation | Start its backend with `KUBEVERSE_CONTEXT=kind-minishop`; see [INTEGRATION.md](INTEGRATION.md). |
| KubeVerse roads disappear | Live traffic is a rolling five-second window; make a fresh browse/cart/checkout request. No traffic is invented when idle. |

`./scripts/reset.sh` restores healthy payment settings, a 100 ms payment delay and one Checkout replica. It preserves data and never deletes the cluster. [DEMO.md](DEMO.md) has the exact judging flow. [docs/VERIFICATION.md](docs/VERIFICATION.md) records the passing Compose and real kind deployment checks, runtime evidence, and remaining KubeVerse frontend limitations.
