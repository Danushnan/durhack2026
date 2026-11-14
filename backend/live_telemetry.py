"""Measured live observations, independent of transport and persistence.

Only incoming HTTP completions contribute to service request metrics. Outgoing
calls and dependency operations remain available to edge/persistence consumers.
"""

from collections import Counter
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
import hashlib
import json
import logging
import math
import threading


COMPONENTS = {
    "minishop-web": "proxy_access", "product-api": "http_server",
    "cart-api": "http_server", "checkout-api": "http_server",
    "payment-api": "http_server", "postgres": "unsupported", "redis": "unsupported",
}
logger = logging.getLogger(__name__)


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat() if timestamp is not None else None


def epoch(value):
    if not isinstance(value, str):
        raise ValueError("timestamp must be a string")
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.utcoffset() is None:
        raise ValueError("timestamp must include timezone")
    return parsed.timestamp()


def number(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValueError("measurement must be finite and numeric")
    return value


def endpoint(host, namespace):
    if not isinstance(host, str) or not host:
        return None
    parts = host.rstrip(".").split(".")
    # Bare Service name, name.namespace, or Kubernetes Service DNS only.
    if len(parts) > 2 and parts[2] != "svc":
        return None
    if any(not part or any(c not in "abcdefghijklmnopqrstuvwxyz0123456789-" for c in part) for part in parts):
        return None
    return f"{parts[1] if len(parts) > 1 else namespace}/{parts[0]}"


@dataclass(frozen=True)
class Observation:
    event_id: str
    application: str
    observed_at: float  # Unix seconds, completion time
    service: str       # namespace/deployment of the emitting workload
    event: str
    pod_uid: str
    pod: str
    container: str
    runtime_timestamp: str | None
    request_id: str | None
    source: str | None
    target: str | None
    method: str | None
    route: str | None
    operation: str | None
    status: int
    latency_ms: float
    error: str | None
    outcome: str | None

    def as_dict(self):
        return asdict(self)


def parse_log(line, *, namespace, deployment, pod_uid, pod, container="workload", application="minishop"):
    """Return a validated observation, or None for unsupported/malformed logs.

    Accept both kubectl --timestamps output and genuine unprefixed Python logs.
    Nginx requires the runtime timestamp because its payload has no timestamp.
    """
    try:
        payload = line.strip()
        runtime_timestamp = None
        if not payload.startswith("{"):
            runtime_timestamp, payload = payload.split(" ", 1)
            epoch(runtime_timestamp)
        record = json.loads(payload)
        if not isinstance(record, dict):
            return None
        kind = record.get("event", "legacy_client")
        if kind not in {"http_server", "http_client", "dependency", "proxy_access", "legacy_client"}:
            return None
        if kind != "legacy_client" and record.get("service") != deployment:
            return None
        route = record.get("route")
        if kind in {"http_server", "http_client", "proxy_access"}:
            if not isinstance(route, str) or not route.startswith("/"):
                return None
            if route in {"/health/live", "/health/ready"}:
                return None
            if kind == "proxy_access" and not route.startswith("/api/"):
                return None
            if not isinstance(record.get("method"), str) or not record["method"]:
                return None
        if "timestamp_ms" in record:
            observed_at = number(record["timestamp_ms"]) / 1000
        elif record.get("timestamp") is not None:
            observed_at = epoch(record["timestamp"])
        elif runtime_timestamp:
            observed_at = epoch(runtime_timestamp)
        else:
            return None
        status = record["status"]
        if isinstance(status, bool) or not isinstance(status, int) or not 100 <= status <= 599:
            return None
        latency = number(record["duration_seconds"]) * 1000 if kind == "proxy_access" else number(
            record.get("latency_ms", record.get("duration_ms")) if kind == "legacy_client" else record["latency_ms"])
        number(latency)
        if latency < 0 or observed_at < 0:
            return None
        service = f"{namespace}/{deployment}"
        source = endpoint(record.get("source"), namespace)
        target = endpoint(record.get("target"), namespace)
        if kind in {"http_client", "dependency", "legacy_client"} and (source is None or target is None):
            return None
        if kind == "http_server" and source is None:
            caller = record.get("source_service", "external")
            source = "external" if caller == "external" else endpoint(caller, namespace)
        identity = json.dumps(record, sort_keys=True, separators=(",", ":"), allow_nan=False)
        event_id = hashlib.sha256("\0".join((pod_uid, container, runtime_timestamp or "", identity)).encode()).hexdigest()
        def optional_string(key):
            value = record.get(key)
            if value is not None and not isinstance(value, str):
                raise ValueError(f"{key} must be a string")
            return value
        return Observation(
            event_id, application, observed_at, service, kind, pod_uid, pod, container,
            runtime_timestamp, optional_string("request_id") or optional_string("trace_id"),
            source, target, optional_string("method"), optional_string("route"),
            optional_string("operation"), status, float(latency), optional_string("error"),
            optional_string("outcome"),
        )
    except (ValueError, TypeError, KeyError, OverflowError):
        return None


class LiveTelemetry:
    def __init__(self, context, namespace="minishop", window_seconds=10, stale_seconds=10,
                 error_threshold=0.1, latency_threshold_ms=1000):
        for value in (window_seconds, stale_seconds, latency_threshold_ms):
            if number(value) <= 0:
                raise ValueError("telemetry windows and latency threshold must be positive")
        if not 0 <= number(error_threshold) <= 1:
            raise ValueError("error threshold must be a fraction")
        self.context, self.namespace = context, namespace
        self.window_seconds, self.stale_seconds = window_seconds, stale_seconds
        self.error_threshold, self.latency_threshold_ms = error_threshold, latency_threshold_ms
        self.retention = max(60, window_seconds + 10, stale_seconds + 10)
        self._lock = threading.RLock()
        self._seen, self._observations, self._subscribers = {}, [], []
        self._resources, self._pods, self._polls = {}, {}, {}
        self.last_resource_refresh = None
        self.resource_error = None
        self.last_application_event = None
        self._last_events = {}
        self._invalid_until = {}
        self.rejected_records = 0

    def subscribe(self, callback):
        """Subscribe to new deduplicated tuples; use queue.put, not DB I/O here.

        Callback runs on the collector thread. Returns an unsubscribe function.
        Delivery is in-process and best effort, not a durable persistence queue.
        """
        with self._lock:
            self._subscribers.append(callback)
        def unsubscribe():
            with self._lock:
                if callback in self._subscribers:
                    self._subscribers.remove(callback)
        return unsubscribe

    def set_resources(self, resources, pods, now):
        with self._lock:
            self._resources = dict(resources)
            self._pods = {p["uid"]: dict(p) for p in pods}
            self._polls = {uid: state for uid, state in self._polls.items() if uid in self._pods}
            self.last_resource_refresh, self.resource_error = now, None

    def resource_failed(self, reason):
        with self._lock:
            self.resource_error = reason

    def poll_result(self, uid, now, *, since, error=None, truncated=False, successful_read=None):
        with self._lock:
            state = self._polls.setdefault(uid, {"last_success": None, "coverage_start": None})
            state["error"] = error
            state["truncated"] = truncated
            if successful_read is None:
                successful_read = error is None
            if successful_read:
                if state["last_success"] is None or since > state["last_success"] or truncated:
                    state["coverage_start"] = since if not truncated else now
                state["last_success"] = now

    def ingest(self, observations, now):
        """Accept validated records once; return exactly the newly accepted tuple."""
        with self._lock:
            self._prune(now)
            accepted = []
            for row in observations:
                if not now - self.retention < row.observed_at <= now + 2:
                    self.rejected_records += 1
                    if row.observed_at > now + 2:
                        self._invalid_until[row.service] = now + self.window_seconds
                    continue
                if row.event_id in self._seen:
                    continue
                self._seen[row.event_id] = row.observed_at
                self._observations.append(row)
                accepted.append(row)
                if row.application == "minishop" and row.event in {"http_server", "proxy_access"}:
                    self.last_application_event = max(self.last_application_event or 0, row.observed_at)
                    self._last_events[row.service] = max(self._last_events.get(row.service, 0), row.observed_at)
            subscribers = tuple(self._subscribers)
        batch = tuple(accepted)
        if batch:
            for callback in subscribers:
                try:
                    callback(batch)
                except Exception:
                    logger.exception("Live observation subscriber failed; batch is not retried")
        return batch

    def ingest_logs(self, logs, pod, now):
        rows, occurrences = [], Counter()
        for line in logs.splitlines():
            row = parse_log(line, namespace=pod["namespace"], deployment=pod["deployment"],
                            pod_uid=pod["uid"], pod=pod["name"], application=(
                                "minishop" if pod["namespace"] == self.namespace and pod["deployment"] in COMPONENTS
                                else "kubeverse-demo"))
            if row is not None:
                occurrences[row.event_id] += 1
                # Preserve identical occurrences within a response; overlap replays
                # use the same ordinal. See documented log-offset limitation.
                row = replace(row, event_id=f"{row.event_id}:{occurrences[row.event_id]}")
                rows.append(row)
            else:
                # Normal startup/database logs, probes and diagnostic events are
                # intentionally ignored. Invalid measurement records make the
                # service window partial instead of masquerading as no traffic.
                payload = line.strip()
                if not payload.startswith("{"):
                    payload = payload.partition(" ")[2]
                candidate = False
                try:
                    data = json.loads(payload)
                    candidate = isinstance(data, dict) and data.get("event") in {
                        "http_server", "http_client", "dependency", "proxy_access"}
                    if candidate and (data.get("route") in {"/health/live", "/health/ready"}
                                      or (data.get("event") == "proxy_access" and isinstance(data.get("route"), str)
                                          and not data["route"].startswith("/api/"))):
                        candidate = False
                except (ValueError, TypeError):
                    candidate = payload.startswith("{")
                if candidate:
                    with self._lock:
                        self.rejected_records += 1
                        self._invalid_until[pod["service"]] = now + self.window_seconds
        return self.ingest(rows, now)

    def _prune(self, now):
        cutoff = now - self.retention
        self._seen = {key: stamp for key, stamp in self._seen.items() if stamp > cutoff}
        self._observations = [row for row in self._observations if row.observed_at > cutoff]
        self._invalid_until = {key: until for key, until in self._invalid_until.items() if until > now}

    def edge_observations(self, now):
        """Share measured calls with the existing traffic formatter, without rereads."""
        with self._lock:
            return tuple(row for row in self._observations
                         if now - 5 <= row.observed_at <= now and row.source is not None and row.target is not None)

    def health_event(self, now):
        with self._lock:
            return {"type": "HEALTH", "stale": bool(self.resource_error) or self.last_resource_refresh is None
                    or now - self.last_resource_refresh > self.stale_seconds,
                    "lastRefresh": self.last_resource_refresh * 1000 if self.last_resource_refresh is not None else None}

    def snapshot(self, now):
        with self._lock:
            self._prune(now)
            resource_stale = self.health_event(now)["stale"]
            services = []
            for name, kind in COMPONENTS.items():
                key = f"{self.namespace}/{name}"
                resource = self._resources.get(key)
                pods = [p for p in self._pods.values() if p["service"] == key]
                states = [self._polls.get(p["uid"], {}) for p in pods]
                successes = [s["last_success"] for s in states if s.get("last_success") is not None]
                last_poll = min(successes) if successes else None
                complete = bool(states) and self._invalid_until.get(key, 0) <= now and all(
                    not s.get("error") and not s.get("truncated", False)
                    and s.get("coverage_start") is not None and s["coverage_start"] <= now - self.window_seconds
                    and s.get("last_success") is not None and now - s["last_success"] <= self.stale_seconds
                    for s in states)
                supported = kind != "unsupported"
                rows = [r for r in self._observations if r.service == key and r.event == kind
                        and now - self.window_seconds < r.observed_at <= now]
                last_event = self._last_events.get(key)
                if supported and not complete:
                    availability = "unavailable" if last_poll is None else (
                        "stale" if now - last_poll > self.stale_seconds else "partial")
                else:
                    availability = ("active" if rows else "idle") if supported else "unsupported"
                desired = resource.get("spec", {}).get("replicas", 1) if resource else None
                ready = sum(p["ready"] and not p.get("deleting", False) for p in pods) if resource else None
                infrastructure = "unknown"
                if resource and not resource_stale:
                    infrastructure = ("scaled_down" if desired == 0 else "unavailable" if ready == 0
                                      else "healthy" if ready >= desired else "degraded")
                measurable = supported and (complete or bool(rows))
                count = len(rows)
                errors = sum(r.status >= 500 for r in rows)
                rejections = sum(400 <= r.status < 500 for r in rows)
                latencies = sorted(r.latency_ms for r in rows)
                # Scale before summing so finite samples cannot overflow the
                # mean accumulator (malformed extreme inputs still stay finite).
                scale = latencies[-1] if count else 0
                mean = scale * (sum(value / scale for value in latencies) / count) if scale else (0.0 if count else None)
                p95 = latencies[math.ceil(.95 * count) - 1] if count else None
                rate = errors / count if count else None
                application = "unknown" if supported else "not_applicable"
                if supported and infrastructure in {"unavailable", "scaled_down"}:
                    application = "unavailable"
                elif supported and complete and not resource_stale and count:
                    application = "degraded" if rate >= self.error_threshold or p95 >= self.latency_threshold_ms else "healthy"
                checkout = None
                if name == "checkout-api" and measurable:
                    attempts = [r for r in rows if r.method == "POST" and r.route.startswith("/checkout/")]
                    checkout = {"attempt_count": len(attempts),
                                "success_count": sum(200 <= r.status < 400 for r in attempts),
                                "business_rejection_count": sum(400 <= r.status < 500 for r in attempts),
                                "failure_count": sum(r.status >= 500 for r in attempts),
                                "success_rate": sum(200 <= r.status < 400 for r in attempts) / len(attempts) if attempts else None}
                services.append({
                    "service": key, "namespace": self.namespace,
                    "deployment_uid": resource["metadata"]["uid"] if resource else None,
                    "measurement_kind": kind, "request_count": count if measurable else None,
                    "requests_per_second": count / self.window_seconds if measurable else None,
                    "avg_latency_ms": mean, "p95_latency_ms": p95,
                    "error_count": errors if measurable else None, "error_rate": rate,
                    "business_rejection_count": rejections if measurable else None,
                    "business_decline_count": sum(r.status == 402 for r in rows) if measurable else None,
                    "checkout": checkout, "desired_replicas": desired, "ready_replicas": ready,
                    "infrastructure_status": infrastructure, "application_status": application,
                    "availability": availability, "window_complete": complete if supported else False,
                    "last_log_poll_at": iso(last_poll), "last_event_at": iso(last_event),
                })
            relevant = [s for s in services if s["measurement_kind"] != "unsupported"]
            status = "connected"
            if self.last_resource_refresh is None:
                status = "unavailable"
            elif self.resource_error:
                status = "disconnected"
            elif resource_stale or any(s["availability"] in {"partial", "stale", "unavailable"} for s in relevant):
                status = "degraded"
            source_polls = [state for uid, state in self._polls.items() if uid in self._pods
                            and self._pods[uid]["namespace"] == self.namespace
                            and self._pods[uid]["deployment"] in COMPONENTS]
            polls = [s["last_success"] for s in source_polls if s.get("last_success") is not None]
            errors_text = [s["error"] for s in source_polls if s.get("error")]
            service_keys = {s["service"] for s in services}
            if any(until > now for key, until in self._invalid_until.items() if key in service_keys):
                errors_text.append("Invalid measurement records were ignored; affected windows are partial")
            return {
                "type": "SERVICE_METRICS", "schema_version": 1, "mode": "live", "application": "minishop",
                "source_id": f"kubernetes:{self.context}:{self.namespace}", "context": self.context,
                "observed_at": iso(now), "window": {"start": iso(now - self.window_seconds), "end": iso(now), "seconds": self.window_seconds},
                "source": {"status": status, "last_resource_refresh_at": iso(self.last_resource_refresh),
                           "last_log_poll_at": iso(max(polls)) if polls else None,
                           "last_application_event_at": iso(self.last_application_event),
                           "rejected_records": self.rejected_records,
                           "error": self.resource_error or (errors_text[0] if errors_text else None)},
                "services": services,
            }
