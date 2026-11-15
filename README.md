# KubeVerse — Watch Kubernetes Think

Port Kube is a 3D city that renders a (simulated) Kubernetes cluster live. Namespaces are Districts, each service
(Deployment) is a distinct landmark Building, its Pods are Units on plots out front, and requests are Cars driving between Buildings on shared Roads and roundabouts. Lorries carry requests across districts on highways.
Break things and watch the control loop heal them. See `GLOSSARY.md` for the vocabulary.

## Run the demo

Install Python and Node.js, then open two terminals at the repository root.
The simulator provides the workloads, traffic and interactive failure controls.
Docker and Kubernetes are optional.

**Terminal 1 — backend**

Windows PowerShell:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:KUBEVERSE_MODE = 'sim'
.\.venv\Scripts\python.exe run.py
```

macOS or Linux:

```bash
cd backend
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
KUBEVERSE_MODE=sim .venv/bin/python -m uvicorn main:app --port 8000
```

**Terminal 2 — frontend**

```bash
cd frontend
npm ci
npm run dev
```

In PowerShell, use `npm.cmd` in place of `npm` if script execution is disabled.
Open [http://127.0.0.1:5173](http://127.0.0.1:5173). If Vite prints a different port,
use the address it prints. Keep both terminals open and press **Ctrl+C** in each
to stop the demo.

### Use a running Kubernetes cluster

Install `kubectl` and check the context you want to display. For Docker Desktop
on Windows, run these commands from the `backend` folder in place of the simulator
startup commands:

```powershell
kubectl --context docker-desktop get nodes
Remove-Item Env:KUBEVERSE_MODE -ErrorAction SilentlyContinue
$env:KUBEVERSE_CONTEXT = 'docker-desktop'
.\.venv\Scripts\python.exe run.py
```

Live cluster mode is read-only. The demo script below uses the simulator.

#### Live demo on macOS (Docker Desktop)

1. In Docker Desktop, open **Settings → Kubernetes**, enable it, and wait until it shows as running
   (`kubectl --context docker-desktop get nodes` lists your Nodes).
2. Deploy the demo shop: real Pods that call each other over HTTP and log every request.
   ```bash
   ./k8s/up.sh            # remove it later with ./k8s/down.sh
   ```
3. Start the backend against the cluster (instead of the simulator command above), and the frontend as usual:
   ```bash
   cd backend
   KUBEVERSE_CONTEXT=docker-desktop .venv/bin/python -m uvicorn main:app --port 8000
   ```
4. Break and heal things with real `kubectl` and watch the city react within a few seconds:
   ```bash
   kubectl -n shop scale deploy/payments --replicas=0     # payments DOWN: failures burst and return red; inspect HTTP replies versus failed communication
   kubectl -n shop scale deploy/payments --replicas=2     # it heals
   kubectl -n shop delete pod -l app=cart --wait=false    # Pods replaced by the ReplicaSet controller
   kubectl -n shop scale deploy/frontend --replicas=5     # the Building grows, new Units warm up before taking traffic
   kubectl drain desktop-worker --ignore-daemonsets --delete-emptydir-data   # Units move to the other Node
   kubectl uncordon desktop-worker
   ```

Every demo Pod runs `k8s/workload.py`: it answers on port 8080, calls the services listed in its `CALLS`, and
logs one JSON line per call (`200` served, `500` answered with an error, `503` refused), which becomes a Car.

## Demo script

1. Press **?** for a short explainer of the city and of how Kubernetes thinks (desired vs actual state).
2. Hover a Building to see what the service does and what breaks if it stops; click it (or pick it from the left rail)
   to fly there and open the inspect panel. Each button shows the `kubectl` command it stands for.
3. **Demolish** a Unit → it shuts down, Kubernetes creates a replacement, the scheduler places it. Watch the glowing
   **messengers** fly from **City Hall** (the control plane) and from the Power Stations' kubelets.
4. **Sabotage** `payments` (the Bank) → its Units crash; Cars to it are refused and turn back **red**; checkout is now
   **Impacted**, so Cars to checkout wait at its door, queue, burst, and come back **red** (an HTTP error answer). Both error replies and failed communication use red return vehicles; route details distinguish them. A MiniShop HTTP 402 payment decline is a business outcome, not evidence of a pod outage.
5. **Release v2** of the Bank → Unit caps change colour one at a time and the Service never drops below 2 ready Units.
   **Release buggy v3** → the rollout stalls with v2 still serving; **Roll back** returns to v2.
6. Customers (yellow taxis) enter through the **City Gate** (an Ingress). Each delivered request flashes the ready Unit
   that served it (round-robin). Press **🚦** for rush hour: customers triple, the frontend's autoscaler adds Units
   (the Building grows), Roads fill up, and it scales back down afterwards. Cart and checkout have no autoscaler, so
   they stay **Slow** (ringed) for the whole rush: the bottleneck moves downstream. Add Units to cart by hand and watch
   its latency and ring go away.
7. The database (`postgres`, the Archive) is a **StatefulSet**: Demolish `postgres-0` and the same name returns with the
   same **storage tank**. Cut its Power Station's power and it is *not* copied elsewhere; it waits until power returns.
8. Click a **Power Station** (a Node): **Maintenance** (`kubectl drain`) moves Units out gently, never breaking a
   service's disruption budget; **Cut power** is the sudden version: Kubernetes only notices once the heartbeats stop,
   marks the Node NotReady, takes its Units out of rotation, and evicts them when their toleration runs out.
   Toggle **⚡ Power Grid** to colour Units by Node.
9. Request health is shown apart from Pod health. A Building glows by its requests, and a shared Road shows the most
   affected route using it. The states are healthy, slow (≥ 300 ms), errors (≥ 1% answered with an error), refused
   (nobody answered) and idle. A Building’s Units show its Pods. A healthy Building's tag shows only its name; a Pods line and a requests line
   appear when it needs attention, is rolling out, or is selected (hover always shows them). A pulsing ring (with a light beam when serious) marks every
   Building that needs attention, and the **overview** (bottom left) gives total requests/s in, latency, the failing share,
   counts of healthy, degraded (ring only: slow, missing Pods) and failed (ring and beam: down, refusing, errors, impacted)
   services, and lists the affected ones. A Building's inspect panel shows its **recent errors**: failed requests from the
   Pods' logs (live mode) and Kubernetes warnings. Hover a Road for its numbers; **Key** opens the legend with the thresholds. In a Building's inspect panel,
   **More Kubernetes details** and **What Kubernetes did** are folded away until opened.
10. The city is isometric by default: drag to pan, scroll or pinch to zoom. **3D** switches to a free 3D view (drag to
   orbit, right-drag to pan); **ISO** switches back.
   **⟲** resets the city; **🌙 / ☀️** switches night and day; **⌂** returns the camera to the overview. The ticker at
   the bottom explains each thing Kubernetes does; click it for the full list.

## Simulated cases

The controller chain is the real one: the Deployment controller owns one ReplicaSet per Pod template (named with its
`pod-template-hash`, old ones kept at 0 for roll back), and the ReplicaSet controller creates and deletes the Pods
(`ownerReferences` link them). The scheduler filters out tainted Nodes (cordoned: `unschedulable:NoSchedule`,
dead: `unreachable:NoExecute`) and full ones (FailedScheduling → Pending), then spreads a workload's replicas across
Nodes. Pods get IPs; each Service has an EndpointSlice listing its Pods, and only ready ones receive requests.

Also simulated: container start-up, readiness (running before ready), CrashLoopBackOff with exponential back-off,
graceful termination, scale up/down and self-healing, rolling updates with the default 25% maxSurge/maxUnavailable,
progress deadline and rollback, an Ingress routing customers to frontend, a HorizontalPodAutoscaler on requests per
second per Pod, a StatefulSet with ordered Pods and PersistentVolumeClaims, PodDisruptionBudgets with `kubectl drain`,
the Node lifecycle (missed heartbeats → NotReady and an unreachable taint → Pods out of rotation → eviction after their
toleration; they stay Terminating until the Node returns), and error propagation to callers of an impacted service.
Traffic flows from the Ingress down the call graph: a service only calls its dependencies while requests reach it.
In live mode (a real cluster) the city is read-only.

Not simulated: CPU and memory requests (Nodes have Pod slots instead), liveness probes, DaemonSets, Jobs, NetworkPolicies
and ConfigMaps/Secrets.
Timings are compressed for the demo (see `shortcut:` comments in `backend/sim.py`).

Both modes stream Kubernetes-shaped updates (`ADDED`/`MODIFIED`/`DELETED`) over `/ws`. Each `TRAFFIC` edge carries
`rps`, `latency_ms`, `error_rate` (answered with an error) and `refused_rate` (nobody answered). The simulator models
latency from load per ready Pod and spreads failures to callers by how often they need the broken service.

In live mode, request routes are the union of the calls each app declares (an `architecture.json` manifest such as
`minishop/architecture.json`, or a workload's `CALLS`/`DEPENDENCIES` env var), the calls seen since the backend started,
and the last five seconds of logs. A known route stays visible at 0 req/s when traffic stops. Hover a shared Road
to see the calls that use it. A manifest component missing from its (existing) namespace is still drawn, marked
**Not deployed**. Log lines may report `latency_ms`, `duration_ms` or `duration_seconds`; a call counts as refused only when
the caller got no HTTP answer (a 504, a plain 503, or an exception such as a connection error), and as an error when the
callee answered with one (e.g. MiniShop's 402 payment declines, which leave every Pod Ready).

## TigerData network analytics

Copy `backend/.env.example` to `backend/.env` and put your Tiger Cloud PostgreSQL connection
string on the `TIGERDATA_DATABASE_URL` line. Use the URI from Tiger Console, including its TLS settings.
The local file is ignored by Git. The database role needs permission to create the
`kubeverse_requests` hypertable and its index and to insert and query rows.

On Windows, start the backend from the repository root in PowerShell after saving the file:

```powershell
Set-Location backend
$env:KUBEVERSE_MODE = 'sim'
.\.venv\Scripts\python.exe run.py
```

Use `run.py` on Windows so Uvicorn uses the selector event loop required by Psycopg.

Open **Network analytics** (▥) in the city's view controls. Let healthy simulated traffic
accumulate for about 20 seconds, then sabotage **payments**. The panel shows request counts,
latency, error rates, latency anomalies and possible propagation from Payments back through
Checkout and Frontend. Expand a path to see its time buckets, and scrub the slider to replay
network measurements. The slider covers the current backend run. The city layout and Kubernetes
resource controls continue to use the live simulation.
