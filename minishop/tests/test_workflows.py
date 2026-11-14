from concurrent.futures import ThreadPoolExecutor
import json
from uuid import uuid4

import httpx
import psycopg
from redis import Redis


def add(shop, quantity=1):
    client, urls, session, _, p = shop
    response = client.post(f"{urls['cart']}/carts/{session}/items", json={"product_id": p["id"], "quantity": quantity})
    assert response.status_code == 200, response.text


def checkout(shop, name="checkout", rid=None):
    client, urls, session, key, _ = shop
    return client.post(f"{urls[name]}/checkout/{session}", headers={"Idempotency-Key": key, "X-Request-ID": rid or str(uuid4())})


def test_health(stack):
    for url in stack["urls"].values():
        for endpoint in ("live", "ready"):
            assert httpx.get(f"{url}/health/{endpoint}").status_code == 200


def test_products_are_postgres_data(shop, stack):
    client, urls, _, _, p = shop
    with psycopg.connect(stack["dsn"]) as conn:
        rows = conn.execute("SELECT count(*) FROM products").fetchone()[0]
        assert rows == 10
        conn.execute("UPDATE products SET description=description || ' Database proof.' WHERE id=%s", (p["id"],))
    try:
        response = client.get(f"{urls['products']}/products/{p['id']}")
        assert response.json()["description"].endswith("Database proof.")
    finally:
        with psycopg.connect(stack["dsn"]) as conn:
            conn.execute("UPDATE products SET description=%s WHERE id=%s", (p["description"], p["id"]))
    assert client.get(f"{urls['products']}/products/{uuid4()}").status_code == 404


def test_basket_updates_live_in_redis(shop, stack):
    client, urls, session, _, p = shop
    assert client.get(f"{urls['cart']}/carts/{session}").json()["items"] == []
    add(shop)
    add(shop)
    with Redis.from_url(stack["redis"], decode_responses=True) as redis:
        assert json.loads(redis.get(f"cart:{{{session}}}"))["items"][p["id"]] == 2
    item_url = f"{urls['cart']}/carts/{session}/items/{p['id']}"
    assert client.put(item_url, json={"quantity": 3}).status_code == 200
    assert client.get(f"{urls['cart']}/carts/{session}").json()["total_cents"] == p["price_cents"] * 3
    assert client.put(item_url, json={"quantity": 0}).status_code == 422
    assert client.post(f"{urls['cart']}/carts/{session}/items", json={"product_id": str(uuid4()), "quantity": 1}).status_code == 404
    assert client.post(f"{urls['cart']}/carts/{session}/items", json={"product_id": p["id"], "quantity": 1, "price_cents": 1}).status_code == 422
    assert client.put(item_url, json={"quantity": 99}).status_code == 409
    assert client.delete(item_url).status_code == 200
    assert client.get(f"{urls['cart']}/carts/{session}").json()["items"] == []


def test_successful_checkout_persists_across_processes(shop, stack):
    client, urls, session, _, p = shop
    add(shop, 2)
    result = checkout(shop)
    assert result.status_code == 200, result.text
    order = result.json()
    assert order["total_cents"] == 2 * p["price_cents"]
    assert order["payment_status"] == "simulated_paid"
    assert order["payment_reference"].startswith("sim_")
    assert order["basket_cleared"]
    assert client.get(f"{urls['cart']}/carts/{session}").json()["items"] == []
    with psycopg.connect(stack["dsn"]) as conn:
        assert conn.execute("SELECT total_cents FROM orders WHERE id=%s", (order["id"],)).fetchone()[0] == order["total_cents"]
        assert conn.execute("SELECT count(*) FROM order_items WHERE order_id=%s", (order["id"],)).fetchone()[0] == 1
    # An independent process has no shared Python memory with the first checkout.
    assert client.get(f"{urls['checkout-replica']}/orders/{session}").json()[0]["id"] == order["id"]
    assert client.get(f"{urls['checkout']}/orders/{uuid4()}").json() == []


def test_payment_failure_has_no_order_and_retains_basket(shop, stack):
    client, urls, session, _, _ = shop
    add(shop)
    response = checkout(shop, "failed-checkout")
    assert response.status_code == 402, response.text
    with psycopg.connect(stack["dsn"]) as conn:
        assert conn.execute("SELECT count(*) FROM orders WHERE session_id=%s", (session,)).fetchone()[0] == 0
    assert len(client.get(f"{urls['cart']}/carts/{session}").json()["items"]) == 1
    assert client.get(urls["failed-payments"] + "/health/ready").status_code == 200
    assert checkout(shop).status_code == 200  # Same key succeeds after restoring provider.


def test_empty_basket_and_missing_key(shop):
    client, urls, session, _, _ = shop
    assert checkout(shop).status_code == 409
    assert client.post(f"{urls['checkout']}/checkout/{session}").status_code == 422


def test_concurrent_duplicate_checkout_across_replicas(shop, stack):
    _, urls, session, key, _ = shop
    add(shop)
    def submit(name):
        return httpx.post(f"{urls[name]}/checkout/{session}", headers={"Idempotency-Key": key}, timeout=15)
    with ThreadPoolExecutor(2) as executor:
        responses = list(executor.map(submit, ["checkout", "checkout-replica"]))
    assert any(r.status_code == 200 for r in responses)
    assert all(r.status_code in (200, 409) for r in responses)
    order_id = next(r.json()["id"] for r in responses if r.status_code == 200)
    assert checkout(shop, "checkout-replica").json()["id"] == order_id
    with psycopg.connect(stack["dsn"]) as conn:
        assert conn.execute("SELECT count(*) FROM orders WHERE session_id=%s", (session,)).fetchone()[0] == 1
    # Replaying an old successful checkout must never remove a new basket.
    add(shop)
    assert checkout(shop).json()["id"] == order_id
    assert len(httpx.get(f"{urls['cart']}/carts/{session}").json()["items"]) == 1


def test_request_id_reaches_every_service_and_failed_call(shop, stack):
    add(shop)
    rid = str(uuid4())
    response = checkout(shop, "failed-checkout", rid)
    assert response.headers["X-Request-ID"] == rid
    events = []
    for path in stack["logs"].glob("*.log"):
        for line in path.read_text().splitlines():
            if line.startswith('{'):
                event = json.loads(line)
                if event.get("request_id") == rid:
                    events.append(event)
    assert {e["service"] for e in events} >= {"checkout-api", "cart-api", "product-api", "payment-api"}
    calls = [e for e in events if e["event"] == "http_client"]
    assert any(e["status"] == 402 and e["route"] == "/payments" for e in calls)
    assert all(e["timestamp_ms"] > 1_000_000_000_000 and e["latency_ms"] >= 0 for e in calls)
    assert httpx.get(stack["urls"]["products"] + "/products", headers={"X-Request-ID": "bad"}).headers["X-Request-ID"] != "bad"


def test_internal_routes_require_token(shop):
    client, urls, session, _, _ = shop
    assert client.post(f"{urls['cart']}/internal/carts/{session}/snapshot", json={"token": str(uuid4())}).status_code == 403
    assert client.post(urls["payments"] + "/payments", json={"session_id": session, "idempotency_key": str(uuid4()), "amount_cents": 100, "currency": "GBP"}).status_code == 403


def test_checkout_freeze_blocks_mutations_and_can_be_released(shop):
    client, urls, session, _, p = shop
    add(shop)
    token = str(uuid4())
    headers = {"X-Internal-Token": "integration-test-token"}
    snapshot = client.post(f"{urls['cart']}/internal/carts/{session}/snapshot", json={"token": token}, headers=headers).json()
    assert client.put(f"{urls['cart']}/carts/{session}/items/{p['id']}", json={"quantity": 2}).status_code == 409
    assert client.post(f"{urls['cart']}/internal/carts/{session}/finish", json={"token": token, "version": snapshot["version"], "clear": False}, headers=headers).status_code == 200
    assert client.put(f"{urls['cart']}/carts/{session}/items/{p['id']}", json={"quantity": 2}).status_code == 200


def test_unreachable_payment_is_real_http_failure(shop, stack):
    client, urls, session, key, _ = shop
    add(shop)
    url = stack["start"]("unreachable-checkout", "checkout", PRODUCT_URL=urls["products"], CART_URL=urls["cart"], PAYMENT_URL="http://127.0.0.1:1")
    response = client.post(f"{url}/checkout/{session}", headers={"Idempotency-Key": key})
    assert response.status_code == 503
    assert client.get(f"{urls['cart']}/carts/{session}").json()["items"]
    assert client.get(f"{urls['checkout']}/orders/{session}").json() == []


def test_order_survives_checkout_process_replacement(shop, stack):
    client, urls, session, key, _ = shop
    add(shop)
    env = {"PRODUCT_URL": urls["products"], "CART_URL": urls["cart"], "PAYMENT_URL": urls["payments"]}
    first = stack["start"]("replacement-checkout", "checkout", **env)
    order = client.post(f"{first}/checkout/{session}", headers={"Idempotency-Key": key}).json()
    process = stack["processes"]["replacement-checkout"]
    process.terminate()
    process.wait(timeout=5)
    replacement = stack["start"]("replacement-checkout", "checkout", **env)
    assert client.get(f"{replacement}/orders/{session}").json()[0]["id"] == order["id"]
    assert client.post(f"{replacement}/checkout/{session}", headers={"Idempotency-Key": key}).json()["id"] == order["id"]
