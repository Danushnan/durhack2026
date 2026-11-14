# KubeVerse — Watch Kubernetes Think

Port Kube is a 3D city that renders a (simulated) Kubernetes cluster live. Namespaces are Districts, each service
(Deployment) is a distinct landmark Building, its Pods are Units on plots out front, a Road joins two Buildings only
where one service calls the other, and requests are Cars driving those Roads. Break things and watch the control loop heal them. See `GLOSSARY.md` for the vocabulary.

## Run (two terminals)

```bash
# 1. Simulated Cluster (FastAPI, port 8000)
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn main:app --port 8000

# 2. City (Vite, port 5173 — proxies /api and /ws to 8000)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Tests: `cd backend && .venv/bin/pytest`.

## Demo script

1. Press **?** for a short explainer of the city and of how Kubernetes thinks (desired vs actual state).
2. Hover a Building to see what the service does and what breaks if it stops; click it (or pick it from the left rail)
   to fly there and open the inspect panel.
3. **Demolish** a Unit → it shuts down, Kubernetes creates a replacement, the scheduler places it.
4. **Sabotage** `payments` (the Bank) → its Units pulse red ("Crashing, next retry waits 4s"), the Road to it turns red
   and its Cars drive back, and a banner shows the knock-on effect: checkout becomes **Impacted**. **Repair** → it recovers.
5. **Add / Remove Unit** → the Building grows or shrinks with the replicas you ask for; outlined Plots show Units
   Kubernetes still has to create.
6. Click a **Power Station** (a Node) to cut its power → its Units are evicted and rescheduled; with only 10 slots left
   some wait for space (Pending). Toggle **⚡ Power Grid** to colour Units by Node. Click the station again to restore.
7. **🌙 / ☀️** switches night and day (remembered per browser); **⌂** returns the camera to the overview. The ticker at the bottom explains each thing Kubernetes
   does; click it for the full list.

## Simulated cases

Scheduling with per-Node capacity (FailedScheduling → Pending), container start-up, CrashLoopBackOff with exponential
back-off, graceful termination, Deployment reconcile (scale up/down, self-healing), Node NotReady eviction.
Timings are compressed for the demo (see `shortcut:` comments in `backend/sim.py`).

The backend streams Kubernetes-shaped watch events (`ADDED`/`MODIFIED`/`DELETED`) over `/ws`, so a real cluster
could replace `sim.py` without frontend changes.

## TigerData network analytics

Copy `backend/.env.example` to `backend/.env` and put your Tiger Cloud PostgreSQL connection
string on the `TIGERDATA_DATABASE_URL` line. Use the URI from Tiger Console, including its TLS settings.
The local file is ignored by Git. The database role needs permission to create the
`kubeverse_requests` hypertable and its index and to insert and query rows.

On Windows, start the backend from the repository root in PowerShell after saving the file:

```powershell
Set-Location backend
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe run.py
```

Use `run.py` on Windows so Uvicorn uses the selector event loop required by Psycopg.

Open **Network analytics** (▥) in the city's view controls. Let healthy simulated traffic
accumulate for about 20 seconds, then sabotage **payments**. The panel shows request counts,
latency, error rates, latency anomalies and possible propagation from Payments back through
Checkout and Frontend. Expand a path to see its time buckets, and scrub the slider to replay
network measurements. The slider covers the current backend run. The city layout and Kubernetes
resource controls continue to use the live simulation.
