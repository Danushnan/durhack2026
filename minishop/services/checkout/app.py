import asyncio
import os
from uuid import UUID, uuid4
from fastapi import Header, HTTPException
from services.common.runtime import call, db_target, event, make_app, measured, require_ok

app = make_app("checkout-api", database=True)
# Opt-in demonstration capacity, per process/Pod. Health probes bypass this queue.
DEMO_CAPACITY = max(0, min(16, int(os.getenv("KUBEVERSE_DEMO_CAPACITY", "0"))))
DEMO_WORK_MS = max(0, min(2000, int(os.getenv("KUBEVERSE_DEMO_WORK_MS", "0"))))
demo_slots = asyncio.Semaphore(DEMO_CAPACITY or 16)
CART_URL = os.getenv("CART_URL", "http://cart-api:8000")
PRODUCT_URL = os.getenv("PRODUCT_URL", "http://product-api:8000")
PAYMENT_URL = os.getenv("PAYMENT_URL", "http://payment-api:8000")


async def order_view(conn, row):
    items = await (await conn.execute(
        "SELECT product_id, name, quantity, unit_price_cents FROM order_items WHERE order_id=%s ORDER BY name",
        (row["id"],))).fetchall()
    return {k: v for k, v in row.items() if k not in ("idempotency_key", "cart_version", "cart_token")} | {"items": items}


async def finish(session_id, row, clear):
    return await call(app, "POST", f"{CART_URL}/internal/carts/{session_id}/finish",
                      json={"token": str(row["cart_token"]), "version": row["cart_version"], "clear": clear})


@app.get("/orders/{session_id}")
async def orders(session_id: UUID):
    async with measured("checkout-api", db_target(), "orders.select"):
        async with app.state.db.connection() as conn:
            rows = await (await conn.execute("SELECT * FROM orders WHERE session_id=%s ORDER BY created_at DESC LIMIT 50",
                                            (session_id,))).fetchall()
            return [await order_view(conn, row) for row in rows]


@app.post("/checkout/{session_id}")
async def checkout(session_id: UUID, idempotency_key: UUID = Header()):
    try:
        async with asyncio.timeout(45):
            if DEMO_CAPACITY:
                try:
                    await asyncio.wait_for(demo_slots.acquire(), timeout=2)
                except TimeoutError:
                    raise HTTPException(429, "Checkout is busy; retry shortly") from None
                try:
                    await asyncio.sleep(DEMO_WORK_MS / 1000)
                    return await place_order(session_id, idempotency_key)
                finally:
                    demo_slots.release()
            return await place_order(session_id, idempotency_key)
    except TimeoutError:
        raise HTTPException(504, "Checkout timed out. Retry with the same checkout key.") from None


async def place_order(session_id, idempotency_key):
    snapshot = None
    committed = False
    row = None
    try:
        async with measured("checkout-api", db_target(), "orders.transaction"):
            async with app.state.db.connection() as conn:
                # This lock lives in PostgreSQL, so separate replicas share it. Fail
                # fast instead of filling the connection pool with waiting checkouts.
                locked = await (await conn.execute(
                    "SELECT pg_try_advisory_xact_lock(hashtextextended(%s, 0)) AS locked", (str(session_id),))).fetchone()
                if not locked["locked"]:
                    raise HTTPException(409, "Checkout in progress; retry with the same checkout key")
                row = await (await conn.execute("SELECT * FROM orders WHERE session_id=%s AND idempotency_key=%s",
                                               (session_id, idempotency_key))).fetchone()
                if row:
                    async with measured("checkout-api", db_target(), "orders.reuse"):
                        result = await order_view(conn, row)
                else:
                    token = uuid4()
                    snapshot = require_ok(await call(app, "POST", f"{CART_URL}/internal/carts/{session_id}/snapshot",
                                                     json={"token": str(token)}), "Basket is busy; retry shortly")
                    row = {"cart_token": token, "cart_version": snapshot["version"]}
                    if not snapshot["items"]:
                        raise HTTPException(409, "Your basket is empty")
                    products = require_ok(await call(app, "GET", f"{PRODUCT_URL}/products"))
                    catalog = {str(p["id"]): p for p in products}
                    lines = []
                    for pid, qty in snapshot["items"].items():
                        p = catalog.get(pid)
                        if not p or qty < 1 or qty > min(p["stock"], 99):
                            raise HTTPException(409, "A product is unavailable in the requested quantity")
                        lines.append((pid, p["name"], qty, p["price_cents"]))
                    total = sum(qty * price for _, _, qty, price in lines)
                    payment = await call(app, "POST", f"{PAYMENT_URL}/payments", json={
                        "session_id": str(session_id), "idempotency_key": str(idempotency_key),
                        "amount_cents": total, "currency": "GBP"})
                    if payment.status_code == 402:
                        raise HTTPException(402, "Simulated payment declined. Your basket is saved; no money was taken.")
                    paid = require_ok(payment, "Payment service unavailable. Your basket is saved; please retry.")
                    if paid.get("status") != "simulated_paid" or not paid.get("simulated"):
                        raise HTTPException(502, "Unexpected payment response")
                    async with measured("checkout-api", db_target(), "orders.persist"):
                        row = await (await conn.execute("""
                            INSERT INTO orders (session_id,idempotency_key,total_cents,payment_reference,cart_version,cart_token)
                            VALUES (%s,%s,%s,%s,%s,%s) RETURNING *
                        """, (session_id, idempotency_key, total, paid["transaction_id"], snapshot["version"], token))).fetchone()
                        async with conn.cursor() as cursor:
                            await cursor.executemany("""INSERT INTO order_items
                                (order_id,product_id,name,quantity,unit_price_cents) VALUES (%s,%s,%s,%s,%s)""",
                                                     [(row["id"], *line) for line in lines])
                        result = await order_view(conn, row)
            # The connection context has committed both the order and all items.
            committed = True
        try:
            require_ok(await finish(session_id, row, True))
            result["basket_cleared"] = True
        except HTTPException:
            # The order is already durable. Never report payment failure here.
            result["basket_cleared"] = False
            event("checkout-api", "basket_cleanup_pending", order_id=row["id"], status=503)
        result["simulated_payment"] = True
        return result
    finally:
        if snapshot is not None and not committed and row:
            try:
                await finish(session_id, row, False)
            except HTTPException:
                pass  # Redis freeze expires after 120s, even if this pod is killed.
