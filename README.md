# KubeVerse — Watch Kubernetes Think

Port Kube is a 3D city that renders a (simulated) Kubernetes cluster live. Namespaces are Districts, each service
(Deployment) is a distinct landmark Building, its Pods are Units on plots out front, and requests are Cars driving the
streets between Buildings. Break things and watch the control loop heal them. See `GLOSSARY.md` for the vocabulary.

## Run (two terminals)

```bash
# 1. Simulated Cluster (FastAPI, port 8000)
cd backend
python3 -m venv .venv && .venv/bin/pip install fastapi 'uvicorn[standard]' pytest
.venv/bin/uvicorn main:app --port 8000

# 2. City (Vite, port 5173 — proxies /api and /ws to 8000)
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. Tests: `cd backend && .venv/bin/pytest`.

## Demo script

1. Pick a service from the **Buildings** list (or click a Building) → the camera flies there and the inspect panel opens.
2. **Demolish** a Unit → it shuts down, Kubernetes creates a replacement, the scheduler places it.
3. **Sabotage** `payments` (the Bank) → its Units pulse red ("Crashing, next retry waits 4s") and Cars to it turn red,
   flash hazards and turn back. **Repair** → it recovers.
4. **Add / Remove a Unit** → scale up/down; outlined Plots show Units Kubernetes still has to create.
5. **⚡ node-1 cut power** (Node Outage) → its Units are evicted and rescheduled; with only 10 slots left some wait
   for space (Pending). Toggle **Power Grid** to colour Units by Node. Click again to restore.
6. **🌙 / ☀️** switches night and day (remembered per browser). Hover Buildings, Units and Cars for details.

## Simulated cases

Scheduling with per-Node capacity (FailedScheduling → Pending), container start-up, CrashLoopBackOff with exponential
back-off, graceful termination, Deployment reconcile (scale up/down, self-healing), Node NotReady eviction.
Timings are compressed for the demo (see `shortcut:` comments in `backend/sim.py`).

The backend streams Kubernetes-shaped watch events (`ADDED`/`MODIFIED`/`DELETED`) over `/ws`, so a real cluster
could replace `sim.py` without frontend changes.
