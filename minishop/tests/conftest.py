"""Real HTTP processes, PostgreSQL and Redis. No fake database or HTTP transport."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time

import httpx
import psycopg
import pytest
from db.migrate import migrate

ROOT = Path(__file__).resolve().parents[1]


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


@pytest.fixture(scope="session")
def stack(tmp_path_factory):
    dsn = os.getenv("TEST_DATABASE_URL", "postgresql://minishop:minishop-local-only@127.0.0.1:55432/minishop_test")
    redis_url = os.getenv("TEST_REDIS_URL", "redis://127.0.0.1:56379/15")
    migrate(dsn)
    migrate(dsn)  # Repeatability is a tested property.
    logs = tmp_path_factory.mktemp("minishop-logs")
    processes, handles, urls = {}, {}, {}
    base = {**os.environ, "DATABASE_URL": dsn, "REDIS_URL": redis_url, "INTERNAL_TOKEN": "integration-test-token",
            "PAYMENT_DELAY_MS": "200", "PYTHONUNBUFFERED": "1"}

    def start(name, module, **extra):
        port = free_port()
        if name in handles:
            handles[name].close()
        handle = (logs / f"{name}.log").open("w")
        handles[name] = handle
        processes[name] = subprocess.Popen(
            [sys.executable, "-m", "uvicorn", f"services.{module}.app:app", "--port", str(port), "--no-access-log"],
            cwd=ROOT, env={**base, **extra}, stdout=handle, stderr=handle)
        url = urls[name] = f"http://127.0.0.1:{port}"
        for _ in range(150):
            try:
                if httpx.get(url + "/health/ready", timeout=1).status_code == 200:
                    return url
            except httpx.RequestError:
                pass
            if processes[name].poll() is not None:
                raise RuntimeError((logs / f"{name}.log").read_text())
            time.sleep(.1)
        raise RuntimeError(f"{name} did not become ready: {(logs / (name + '.log')).read_text()}")

    try:
        product = start("products", "products")
        cart = start("cart", "cart", PRODUCT_URL=product)
        payment = start("payments", "payments", PAYMENT_FAIL="false")
        failed = start("failed-payments", "payments", PAYMENT_FAIL="true")
        start("checkout", "checkout", PRODUCT_URL=product, CART_URL=cart, PAYMENT_URL=payment)
        start("checkout-replica", "checkout", PRODUCT_URL=product, CART_URL=cart, PAYMENT_URL=payment)
        start("failed-checkout", "checkout", PRODUCT_URL=product, CART_URL=cart, PAYMENT_URL=failed)
        yield {"urls": urls, "dsn": dsn, "redis": redis_url, "logs": logs, "start": start,
               "processes": processes}
    finally:
        for process in processes.values():
            process.terminate()
        for process in processes.values():
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        for handle in handles.values():
            handle.close()


@pytest.fixture
def shop(stack):
    from uuid import uuid4
    with httpx.Client(timeout=15) as client:
        session, key = str(uuid4()), str(uuid4())
        urls = stack["urls"]
        product = client.get(urls["products"] + "/products").json()[0]
        yield client, urls, session, key, product
