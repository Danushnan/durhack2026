"""Shared HTTP correlation and measured KubeVerse-compatible dependency events."""
import contextvars
import hmac
import json
import logging
import os
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from psycopg import Error as DatabaseError
from psycopg.rows import dict_row
from psycopg_pool import AsyncConnectionPool, PoolTimeout
from redis.exceptions import RedisError

request_id = contextvars.ContextVar("request_id", default="")
logger = logging.getLogger("minishop")
logger.setLevel(logging.INFO)
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(handler)
logger.propagate = False


def event(service, kind, **fields):
    logger.info(json.dumps({
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "timestamp_ms": int(time.time() * 1000), "request_id": request_id.get(),
        "service": service, "event": kind, "pod": os.getenv("HOSTNAME", "local"), **fields,
    }, default=str))


@asynccontextmanager
async def measured(service, target, operation):
    started = time.perf_counter()
    status = 200
    error = None
    outcome = "completed"
    try:
        yield
    except HTTPException:
        # A payment decline rolls back a healthy DB transaction. Do not falsely
        # report a PostgreSQL outage or paint its KubeVerse edge as failed.
        outcome = "rolled_back"
        raise
    except BaseException as exc:
        status, error = 503, type(exc).__name__
        raise
    finally:
        event(service, "dependency", source=service, target=target, operation=operation,
              status=status, latency_ms=round((time.perf_counter() - started) * 1000, 2),
              error=error, outcome=outcome)


def database_pool():
    return AsyncConnectionPool(os.environ["DATABASE_URL"], open=False, min_size=1, max_size=5,
                               timeout=3, kwargs={"row_factory": dict_row,
                                                  "options": "-c statement_timeout=15000"})


def db_target():
    return os.getenv("DB_TARGET") or urlsplit(os.environ["DATABASE_URL"]).hostname


def redis_target():
    return os.getenv("REDIS_TARGET") or urlsplit(os.environ["REDIS_URL"]).hostname


def internal(x_internal_token: str = Header(default="")):
    expected = os.environ["INTERNAL_TOKEN"]
    if not hmac.compare_digest(x_internal_token, expected):
        raise HTTPException(403, "Internal endpoint")


async def call(app, method, url, **kwargs):
    service = app.state.service
    headers = {"X-Request-ID": request_id.get(), "X-Source-Service": service,
               "X-Internal-Token": os.environ["INTERNAL_TOKEN"], **kwargs.pop("headers", {})}
    start = time.perf_counter()
    status, error = 503, None
    try:
        response = await app.state.http.request(method, url, headers=headers, **kwargs)
        status = response.status_code
        if status >= 400:
            error = f"HTTP {status}"
        return response
    except httpx.RequestError as exc:
        error = type(exc).__name__
        raise HTTPException(503, f"{urlsplit(url).hostname} is unavailable; please retry") from None
    finally:
        event(service, "http_client", source=service, target=urlsplit(url).hostname,
              method=method, route=urlsplit(url).path, status=status,
              latency_ms=round((time.perf_counter() - start) * 1000, 2), error=error)


def require_ok(response, message="A dependent service could not complete the request"):
    if response.status_code >= 400:
        status = response.status_code if response.status_code in (404, 409, 422) else 503
        raise HTTPException(status, message)
    return response.json()


def make_app(service, *, database=False, redis=False):
    @asynccontextmanager
    async def lifespan(app):
        app.state.http = httpx.AsyncClient(timeout=httpx.Timeout(10, connect=2))
        if database:
            app.state.db = database_pool()
            await app.state.db.open()
        if redis:
            from redis.asyncio import Redis
            app.state.redis = Redis.from_url(os.environ["REDIS_URL"], decode_responses=True,
                                             socket_connect_timeout=2, socket_timeout=3)
        try:
            yield
        finally:
            await app.state.http.aclose()
            if database:
                await app.state.db.close()
            if redis:
                await app.state.redis.aclose()

    app = FastAPI(title=f"MiniShop {service}", lifespan=lifespan)
    app.state.service = service

    @app.middleware("http")
    async def correlate(request: Request, next_handler):
        try:
            rid = str(UUID(request.headers.get("X-Request-ID", "")))
        except ValueError:
            rid = str(uuid4())
        token = request_id.set(rid)
        start = time.perf_counter()
        status, error = 500, None
        try:
            response = await next_handler(request)
            status = response.status_code
            response.headers["X-Request-ID"] = rid
            response.headers["X-Served-By"] = os.getenv("HOSTNAME", service)
            return response
        except Exception as exc:
            error = type(exc).__name__
            return JSONResponse({"detail": "Unexpected service error", "request_id": rid},
                                status_code=500, headers={"X-Request-ID": rid})
        finally:
            fields = dict(method=request.method, route=request.url.path, status=status,
                          source_service=request.headers.get("X-Source-Service", "external"),
                          latency_ms=round((time.perf_counter() - start) * 1000, 2), error=error)
            # The web proxy cannot emit epoch milliseconds itself. This is its actual
            # measured inbound edge; backend-to-backend edges are logged by the caller.
            if request.headers.get("X-Source-Service") == "minishop-web":
                fields.update(source="minishop-web", target=service)
            event(service, "http_server", **fields)
            request_id.reset(token)

    async def unavailable(request, exc):
        event(service, "error", error=type(exc).__name__, status=503)
        return JSONResponse({"detail": "Data store unavailable; please retry"}, status_code=503)

    for exc in (DatabaseError, PoolTimeout, RedisError):
        app.add_exception_handler(exc, unavailable)

    @app.get("/health/live")
    async def live():
        return {"status": "ok", "service": service}

    @app.get("/health/ready")
    async def ready():
        if database:
            async with app.state.db.connection() as conn:
                # Schema presence matters, not merely a listening PostgreSQL socket.
                await conn.execute("SELECT id FROM products LIMIT 1")
                await conn.execute("SELECT id FROM orders LIMIT 1")
        if redis:
            await app.state.redis.ping()
        return {"status": "ready", "service": service}

    return app
