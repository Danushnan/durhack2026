# MiniShop: two-minute Composition demonstration

Do setup before the judging timer. MiniShop makes real requests; its only simulated component is the clearly labelled payment outcome.

## Prepare once

From `minishop/`, with Docker, kind and kubectl installed:

```bash
./scripts/kind-up.sh
./scripts/reset.sh
kubectl --context kind-minishop -n minishop port-forward service/minishop-web 8080:8080
```

Keep that terminal open. In another:

```bash
python3 scripts/smoke.py
kubectl --context kind-minishop -n minishop get pods -o wide
```

Open http://localhost:8080 in a private window for a fresh guest basket. All ten product photos are local; browsing/checkout needs no cloud service. Open a third terminal for the pod watch:

```bash
kubectl --context kind-minishop -n minishop get pods -l app=checkout-api -w
```

KubeVerse can consume MiniShop’s pod/log contracts, but its current live frontend has two pre-existing incompatibilities documented in [INTEGRATION.md](INTEGRATION.md). Until separately fixed, use `kubectl` for the real pod view. Do not present KubeVerse’s simulation as this cluster.

## Judging flow

**0:00–0:30 · One shop, several parts.** Browse a product, open its detail page, add it to the basket and change the quantity. Refresh: the basket remains because it is in Redis, not the React process. Proceed to checkout, point out “Simulated payment provider”, and place a demo order. The confirmation has a real PostgreSQL order UUID.

Say: “Composition is visible here: the storefront, catalogue, basket, checkout and payment provider have separate jobs. One click makes them work together.”

**0:30–0:50 · Show the saved result and real calls.** Expand “Request reference” on the confirmation. Copy its UUID and filter logs:

```bash
./scripts/demo.sh logs | python3 scripts/filter-events.py PASTE_REQUEST_UUID_HERE
```

Point out `checkout-api` calls to Cart, Products and Payment with the same `request_id`, measured duration and actual result. Inspect durable data:

```bash
kubectl --context kind-minishop -n minishop exec deploy/postgres -- \
  psql -U minishop -d minishop -c \
  'SELECT id,total_cents,payment_status FROM orders ORDER BY created_at DESC LIMIT 3;'
```

**0:50–1:15 · Let Kubernetes manage the pieces.** Scale from one Checkout pod to three:

```bash
./scripts/demo.sh scale 3
python3 scripts/replicas.py --expect 3
./scripts/demo.sh delete-pod
```

The watch shows actual new pod names, Ready replicas and replacement after deletion. `replicas.py` prints the actual `X-Served-By` pod names returned through the Kubernetes Service. With other replicas Ready, browse previous orders while the replacement starts.

**1:15–1:45 · Break application health without crashing a pod.** Add another product to the basket and run:

```bash
./scripts/demo.sh fail-payment
```

Place the next demo order. The page shows the real HTTP 402 decline and retains the basket. The Payment pod is still Ready. Checkout logs show the failed Payment call, and no successful order was inserted for that attempt.

Say: “Healthy containers do not guarantee a successful customer journey. The failure is in a dependency’s response.”

**1:45–2:00 · Recover.** Restore the provider and retry the same checkout:

```bash
./scripts/demo.sh restore-payment
```

The order succeeds. Open “Your orders” to see both successful orders. The failed attempt did not create a completed order. Rollout timings vary by laptop; pre-pull images and rehearse these commands.

## Repeatable scenario commands

```bash
# A: real provider failure / recovery (pods stay healthy)
./scripts/demo.sh fail-payment
python3 scripts/smoke.py --expect-payment-failure
./scripts/demo.sh restore-payment
python3 scripts/smoke.py

# Optional latency, measured in actual calls, capped at 8 seconds
./scripts/demo.sh delay-payment 2000
./scripts/demo.sh delay-payment 100

# B: delete exactly one Checkout pod, preserving its Deployment and data
./scripts/demo.sh scale 3
./scripts/demo.sh delete-pod
kubectl --context kind-minishop -n minishop rollout status deploy/checkout-api --timeout=120s
kubectl --context kind-minishop -n minishop get pods -l app=checkout-api -o wide

# C: scale and verify actual Service traffic across replicas
./scripts/demo.sh scale 1
./scripts/demo.sh scale 3
python3 scripts/replicas.py --expect 3

# All scenarios, with assertions and automatic healthy-setting restoration
./scripts/verify-k8s.sh

# Reset settings, preserving PostgreSQL, Redis, orders and the cluster
./scripts/reset.sh
```

If a pod is killed during its checkout, PostgreSQL releases its session lock when the connection closes. The Redis basket freeze expires after 120 seconds. Retry using the frontend’s saved idempotency key. A completed order is returned instead of inserted twice; the cleanup checks basket version before clearing. One in-flight connection may fail during abrupt pod termination, so the UI preserves its checkout key for a safe retry.

Use `MINISHOP_CONTEXT=your-context` for scripts against an explicitly selected existing cluster. None of these scenarios requires deleting the namespace, PVCs or kind cluster.

## Evidence checklist for the actual judging machine

Run `./scripts/verify-k8s.sh` with the frontend port-forward running and keep its output. Capture:

- `kubectl get deployments,pods,services,pvc -o wide` before and after scaling/deletion.
- One successful order ID from the website and its PostgreSQL row.
- Correlated JSON call events for successful and declined checkout IDs.
- The three distinct serving pod names from `scripts/replicas.py`.
- A different replacement pod UID and restored Ready count.

These checks were executed successfully against the real two-node `kind-minishop` cluster after Docker installation. Actual output and correlated cluster logs are linked from [docs/VERIFICATION.md](docs/VERIFICATION.md). In the implementation environment, kubectl is at `/tmp/minishop-bin/kubectl`; run `export PATH=/tmp/minishop-bin:$PATH` in a new terminal if kubectl is not installed globally.
