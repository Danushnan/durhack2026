"""Opt-in, bounded MiniShop action correlation. Never consumes aggregate traffic."""
import os
import re
import threading
import time
from uuid import UUID, uuid4
from typing import Literal

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, ConfigDict

router = APIRouter(prefix="/api/journeys")
TTL, COLLECTION, MAX_EVENTS = 300, 30, 128


class Action(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action_id: UUID
    mutation_id: UUID
    refresh_id: UUID
    mutation: Literal["pending", "succeeded", "failed"] = "pending"
    refresh: Literal["pending", "succeeded", "failed", "not_sent"] = "pending"


def root(row, method):
    pattern = r"/carts/[^/]+/items" if method == "POST" else r"/carts/[^/]+"
    return row.event == "http_server" and row.method == method and bool(re.fullmatch(pattern, row.route or ""))


def public(row):
    data = row.as_dict()
    # Routes include basket session/product IDs. Do not expose those identifiers.
    data["route"] = re.sub(r"[0-9a-fA-F]{8}-[0-9a-fA-F-]{27,}", "{id}", row.route or "") or None
    return data


def reconstruct(rows, action, namespace, collecting, truncated):
    prefix = namespace + "/"
    cart, product, web, pg, redis = [prefix + n for n in ("cart-api", "product-api", "minishop-web", "postgres", "redis")]
    a = [r for r in rows if r.request_id == str(action.mutation_id)]
    b = [r for r in rows if r.request_id == str(action.refresh_id)]
    roots = [[r for r in group if r.service == cart and root(r, method)] for group, method in ((a, "POST"), (b, "GET"))]
    # Any other Cart root under an explicitly assigned ID is a collision, too.
    ambiguous = any(len(group_roots) > 1 or any(r.service == cart and r.event == "http_server" and r not in group_roots
                    for r in group) for group, group_roots in zip((a, b), roots))
    ambiguous |= any(r.source != web for group in roots for r in group)
    ambiguous |= any(r.event == "http_server" and r.source in (web, "external") and r not in expected
                     for group, expected in zip((a, b), roots) for r in group)
    if roots[0] and roots[1]:
        ambiguous |= roots[0][0].route.rsplit("/items", 1)[0] != roots[1][0].route
    def match(group, service, event, target=None, operation=None):
        return [r for r in group if r.service == service and r.source == service and r.event == event
                and (target is None or r.target == target) and (operation is None or r.operation == operation)]
    mutation_roots, refresh_roots = roots
    def success(evidence):
        return bool(evidence) and all(200 <= r.status < 300 and not r.error and r.outcome in (None, "completed") for r in evidence)
    specs = [
        ("mutation", "Storefront sends a separate basket change request to Cart.", [r for r in mutation_roots if r.source == web], web, cart),
        ("product", "Cart asks Product for the item’s availability.", [r for r in match(a, cart, "http_client", product) if r.method == "GET" and re.fullmatch(r"/products/[^/]+", r.route or "")], cart, product),
        ("catalogue", "Product looks up item details in PostgreSQL, the shop’s catalogue database.", match(a, product, "dependency", pg, "products.select_one"), product, pg),
        ("redis", "Cart attempts a basket mutation in Redis. This operation alone does not prove the change was accepted.", match(a, cart, "dependency", redis, "basket.mutate"), cart, redis),
        ("result", "Cart returns the mutation result. A successful root response confirms the change was accepted.", mutation_roots, None, None),
        ("refresh", "Storefront makes a second request to refresh the basket, using a different request ID.", [r for r in refresh_roots if r.source == web], web, cart),
        ("basket", "Cart reads basket data from Redis, the store that remembers the basket.", match(b, cart, "dependency", redis, "basket.get"), cart, redis),
        ("display-products", "Cart asks Product for catalogue details needed to display the basket.", [r for r in match(b, cart, "http_client", product) if r.method == "GET" and r.route == "/products"], cart, product),
    ]
    steps = []
    for key, description, evidence, source, target in specs:
        available = bool(evidence) and not ambiguous
        if key == "result" and available:
            description = ("Cart accepted the basket change (successful mutation root response)." if success(evidence)
                           else "Cart did not accept the basket change. Inspect the root HTTP status below.")
        steps.append(dict(key=key, description=description if available else "Observation unavailable for this stage.",
                          state=("observed" if success(evidence) else "failed") if available else ("pending" if collecting and not ambiguous else "unavailable"),
                          event_ids=[r.event_id for r in evidence] if not ambiguous else [],
                          from_service=source if available else None, to_service=target if available else None,
                          basis="backend"))
    browser = action.refresh
    steps.append(dict(key="browser", description=("The browser reports that it updated the displayed basket." if browser == "succeeded" else
                     "The browser reports that the basket refresh failed; the mutation may still have succeeded." if browser == "failed" else
                     "The browser has not reported a completed basket display update."), state=browser, event_ids=[],
                     from_service=None, to_service=None, basis="browser"))
    failed = any(r.status >= 400 for r in mutation_roots + refresh_roots) or "failed" in (action.mutation, action.refresh)
    complete = all(step["state"] == "observed" for step in steps[:-1]) and browser == "succeeded"
    state = "ambiguous" if ambiguous else "failed" if failed else "complete" if complete else "pending" if collecting else "partial"
    return dict(state=state, collecting=collecting, truncated=truncated, steps=steps,
                mutation_accepted=success(mutation_roots) and not ambiguous,
                browser={"mutation": action.mutation, "refresh": action.refresh}, events=[public(r) for r in rows])


class JourneyStore:
    def __init__(self):
        self.actions = {}
        self.lock = threading.RLock()
        self.session = str(uuid4())

    def register(self, viewer, action, telemetry, now):
        if action.mutation_id == action.refresh_id or any(v not in {"pending", "succeeded", "failed", "not_sent"} for v in (action.mutation, action.refresh)):
            raise HTTPException(422, "Distinct request IDs and valid browser outcomes required")
        with self.lock:
            self.actions = {key: value for key, value in self.actions.items() if value["created"] + TTL > now}
            key = (viewer, str(action.action_id))
            old = self.actions.get(key)
            if old:
                if old["telemetry"] is not telemetry or (old["action"].mutation_id, old["action"].refresh_id) != (action.mutation_id, action.refresh_id):
                    raise HTTPException(409, "Action source and request IDs are immutable")
                for field in ("mutation", "refresh"):
                    before, after = getattr(old["action"], field), getattr(action, field)
                    if before != "pending" and before != after:
                        raise HTTPException(409, "Browser outcome is already final")
                old["action"] = action
            else:
                if len(self.actions) >= 100 or sum(k[0] == viewer for k in self.actions) >= 20:
                    raise HTTPException(429, "Journey capacity reached; actions expire after five minutes")
                ids = {action.mutation_id, action.refresh_id}
                if any(ids & {v["action"].mutation_id, v["action"].refresh_id} for v in self.actions.values()):
                    raise HTTPException(409, "Request ID already assigned to another action")
                self.actions[key] = dict(action=action, telemetry=telemetry, created=now, events={}, truncated=False, finalized=False)
            return self.read(viewer, str(action.action_id), telemetry, now)

    def read(self, viewer, action_id, telemetry, now):
        with self.lock:
            entry = self.actions.get((viewer, action_id))
            if not entry or entry["created"] + TTL <= now:
                self.actions.pop((viewer, action_id), None)
                raise HTTPException(404, "Journey expired or unavailable for this viewer")
            if entry["telemetry"] is not telemetry:
                raise HTTPException(409, "Collector source changed; pair a new action")
            action = entry["action"]
            # A small pre-registration allowance handles the browser relay reaching us after the HTTP request.
            rows, truncated = telemetry.request_observations({str(action.mutation_id), str(action.refresh_id)},
                         entry["created"] - 5, min(now, entry["created"] + COLLECTION), MAX_EVENTS + 1)
            if not entry["finalized"]:
                for row in rows:
                    if len(entry["events"]) < MAX_EVENTS or row.event_id in entry["events"]:
                        entry["events"][row.event_id] = row
                    else:
                        entry["truncated"] = True
            if now >= entry["created"] + COLLECTION:
                entry["finalized"] = True
            entry["truncated"] |= truncated
            evidence = sorted(entry["events"].values(), key=lambda row: (row.observed_at, row.event_id))
            result = reconstruct(evidence, action, telemetry.namespace, now < entry["created"] + COLLECTION, entry["truncated"])
            if result["truncated"] and result["state"] == "complete":
                result["state"] = "partial"
            return dict(action_id=action_id, source=f"kubernetes:{telemetry.context}:{telemetry.namespace}",
                        collector_session=self.session, expires_at=entry["created"] + TTL, **result)


store = JourneyStore()


def access(authorization):
    if os.getenv("KUBEVERSE_JOURNEYS") != "1":
        raise HTTPException(403, "Journeys disabled; enable only in a trusted local demo")
    try:
        scheme, token = (authorization or "").split(" ", 1)
        if scheme != "Bearer":
            raise ValueError()
        viewer = str(UUID(token))
    except ValueError:
        raise HTTPException(401, "Viewer token required") from None
    # Lazy import avoids a circular import and always follows the active live collector.
    import main
    if main.live is None:
        raise HTTPException(409, "Journeys require a live MiniShop collector; simulator is separate")
    return viewer, main.live.telemetry


@router.post("/actions")
def register_action(action: Action, authorization: str | None = Header(default=None)):
    viewer, telemetry = access(authorization)
    return store.register(viewer, action, telemetry, time.time())


@router.get("/{action_id}")
def get_action(action_id: UUID, authorization: str | None = Header(default=None)):
    viewer, telemetry = access(authorization)
    return store.read(viewer, str(action_id), telemetry, time.time())
