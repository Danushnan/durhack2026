# Live MiniShop history

The backend can store MiniShop observations in a dedicated PostgreSQL database.
Start PostgreSQL locally and create a database owned by the role in the URL.
Set the following in the environment or in `backend/.env` and start the backend
as usual.

```dotenv
KUBEVERSE_LIVE_HISTORY_DATABASE_URL=postgresql://history_user:password@127.0.0.1:5432/kubeverse_live_history
```

The writer creates its own versioned schema, so the role needs permission to
create a schema in the dedicated database. Leaving the setting unset disables
history and the history API returns HTTP 503. Only live mode writes events.
The API can read an existing history database while the simulator is running.
The existing `TIGERDATA_DATABASE_URL` setting still belongs to simulator telemetry.

## Storage and delivery

`kubeverse_live_history_v1.runs` holds `run_id` (UUID), Kubernetes `context`,
and `started_at` (Unix seconds). Each writer instance has its own run ID.

`kubeverse_live_history_v1.observations` holds a foreign key to the run and all
fields of the validated `Observation`. The composite primary key is
`(run_id, event_id)`. `observed_at` is Unix seconds as received from the collector.
`latency_ms` is measured milliseconds. PostgreSQL preserves nullable fields as
SQL NULL. See `SCHEMA` in `live_history.py` for the column types and indexes.

After validation and overlap deduplication, the collector calls the history
subscriber with the accepted observations. The subscriber puts them into a
bounded in-memory queue without waiting for capacity. A dedicated thread opens
the database connection, registers the run and writes transactions of up to 128
observations. The inserts use the collector's event ID and ignore conflicts within
the run. Different service events with the same request ID keep their own rows.

The queue holds up to 4,096 observations. A full queue drops incoming observations.
The writer logs queue overflow, database failures and failed batches. Writes are
attempted up to three times with short backoff. Graceful shutdown attempts to
drain the queue and waits up to five seconds for the worker. A crash, prolonged
outage or shutdown timeout can lose queued history. Recent logs can be collected
again under a new run ID after a restart. Each process has its own queue and run.
History has no automatic retention, pagination or replay, and the endpoints follow
the backend's existing access model.

## Read API

### List runs

`GET /api/live-history/runs?limit=10`

```json
{"runs":[{"run_id":"776a21e2-22ad-453c-a744-a2c07d79ab4e","context":"kind-minishop","started_at":1794687470.0}]}
```

### List observations

`GET /api/live-history/observations` accepts optional `run_id`, `start`, `end`,
`service`, `request_id` and `limit`. Combine filters to narrow results. Times
are Unix seconds, with an inclusive start and exclusive end. The service is
the exact namespace/deployment identity. Set `run_id` to select an earlier run,
or omit it to search across runs.

```text
GET /api/live-history/observations?run_id=776a21e2-22ad-453c-a744-a2c07d79ab4e&start=1794687470&end=1794687480&service=minishop%2Fpayment-api&request_id=checkout-123&limit=10
```

```json
{
  "observations": [{
    "run_id": "776a21e2-22ad-453c-a744-a2c07d79ab4e",
    "event_id": "c8cfed6e7979d7ec9afda6bd67a7df17c5aa18ef0a5425070b4fff598012682fc",
    "application": "minishop",
    "observed_at": 1794687479.125,
    "service": "minishop/payment-api",
    "event": "http_server",
    "pod_uid": "example-pod-uid",
    "pod": "payment-api-abc",
    "container": "workload",
    "runtime_timestamp": null,
    "request_id": "checkout-123",
    "source": "minishop/checkout-api",
    "target": null,
    "method": "POST",
    "route": "/payments",
    "operation": null,
    "status": 200,
    "latency_ms": 101.48,
    "error": null,
    "outcome": null
  }]
}
```

Both endpoints return newest first and default to 100 rows. The maximum is 500.
A database failure returns HTTP 503 while the live WebSocket continues serving
updates. Invalid bounds, limits or UUIDs return HTTP 422.

## Test with disposable PostgreSQL

Create a fresh database named `kubeverse_history_test` on a disposable PostgreSQL
instance and point `KUBEVERSE_LIVE_HISTORY_TEST_DATABASE_URL` at it. From the
repository root, using the backend Python environment, run:

```sh
python -m pip install -r backend/requirements.txt
python -m pytest backend
```

The PostgreSQL round-trip test skips if the test URL is unset. The outage,
backpressure and simulator tests run without a running PostgreSQL server.
