# Kuebec — Watch Kubernetes Think

Port Kube is a 3D city that renders a (simulated) Kubernetes cluster live. Namespaces are Districts, each service
(Deployment) is a distinct landmark Building, its Pods are Units on plots out front, a Road joins two Buildings only
where one service calls the other, and requests are Cars driving those Roads. Break things and watch the control loop heal them. See `GLOSSARY.md` for the vocabulary.

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

## Demo script

1. Press **?** for a short explainer of the city and of how Kubernetes thinks (desired vs actual state).
2. Hover a Building to see what the service does and what breaks if it stops; click it (or pick it from the left rail)
   to fly there and open the inspect panel. Each button shows the `kubectl` command it stands for.
3. **Demolish** a Unit → it shuts down, Kubernetes creates a replacement, the scheduler places it. Watch the glowing
   **messengers** fly from **City Hall** (the control plane) and from the Power Stations' kubelets.
4. **Sabotage** `payments` (the Bank) → its Units crash; Cars to it are refused and turn back **red**; checkout is now
   **Impacted**, so Cars to checkout wait at its door, queue, and come back **orange** (an error answer).
5. **Release v2** of the Bank → Unit caps change colour one at a time and the Service never drops below 2 ready Units.
   **Release buggy v3** → the rollout stalls with v2 still serving; **Roll back** returns to v2.
6. Customers (yellow taxis) enter through the **City Gate** (an Ingress). Each delivered request flashes the ready Unit
   that served it (round-robin). Press **🚦** for rush hour: customers triple, the frontend's autoscaler adds Units
   (the Building grows), Roads fill up, and it scales back down afterwards.
7. The database (`postgres`, the Archive) is a **StatefulSet**: Demolish `postgres-0` and the same name returns with the
   same **storage tank**. Cut its Power Station's power and it is *not* copied elsewhere; it waits until power returns.
8. Click a **Power Station** (a Node): **Maintenance** (`kubectl drain`) moves Units out gently, never breaking a
   service's disruption budget; **Cut power** is the sudden version. Toggle **⚡ Power Grid** to colour Units by Node.
9. **⟲** resets the city; **🌙 / ☀️** switches night and day; **⌂** returns the camera to the overview. The ticker at
   the bottom explains each thing Kubernetes does; click it for the full list.

## Simulated cases

Scheduling with per-Node capacity (FailedScheduling → Pending), container start-up, readiness (running before ready),
CrashLoopBackOff with exponential back-off, graceful termination, Deployment reconcile (scale up/down, self-healing),
rolling updates with the default 25% maxSurge/maxUnavailable, progress deadline and rollback, an Ingress routing
customers to frontend, a HorizontalPodAutoscaler on requests per second per Pod, a StatefulSet with ordered Pods and
PersistentVolumeClaims, PodDisruptionBudgets with `kubectl drain`, Node NotReady eviction (Pods stay Terminating until
the Node returns), and error propagation to callers of an impacted service. In live mode (a real cluster) the city is
read-only.
Timings are compressed for the demo (see `shortcut:` comments in `backend/sim.py`).

Both modes stream Kubernetes-shaped updates (`ADDED`/`MODIFIED`/`DELETED`) over `/ws`.

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
