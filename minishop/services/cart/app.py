import json
import os
from uuid import UUID
from fastapi import Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from services.common.runtime import call, internal, make_app, measured, redis_target, require_ok

app = make_app("cart-api", redis=True)
PRODUCT_URL = os.getenv("PRODUCT_URL", "http://product-api:8000")
TTL = 60 * 60 * 24 * 7

# All basket changes, revisions and checkout freezes are atomic inside Redis.
MUTATE = """
if redis.call('EXISTS', KEYS[2]) == 1 then return -1 end
local cart = cjson.decode(redis.call('GET', KEYS[1]) or '{"items":{},"version":0}')
local current = tonumber(cart.items[ARGV[1]] or 0)
local qty = tonumber(ARGV[2])
if ARGV[3] == 'add' then qty = qty + current end
if qty > tonumber(ARGV[5]) or qty > 99 then return -2 end
if qty == 0 then cart.items[ARGV[1]] = nil else cart.items[ARGV[1]] = qty end
local count = 0
for _ in pairs(cart.items) do count = count + 1 end
if count > 30 then return -3 end
cart.version = cart.version + 1
redis.call('SET', KEYS[1], cjson.encode(cart), 'EX', ARGV[4])
return 1
"""
SNAPSHOT = """
if not redis.call('SET', KEYS[2], ARGV[1], 'NX', 'EX', 120) then return nil end
return redis.call('GET', KEYS[1]) or '{"items":{},"version":0}'
"""
FINISH = """
local raw = redis.call('GET', KEYS[1])
if ARGV[3] == 'clear' and raw then
  local cart = cjson.decode(raw)
  if cart.version == tonumber(ARGV[2]) then
    redis.call('SET', KEYS[1], cjson.encode({items={},version=cart.version+1}), 'EX', ARGV[4])
  end
end
if redis.call('GET', KEYS[2]) == ARGV[1] then redis.call('DEL', KEYS[2]) end
return 1
"""


def keys(session_id):
    # Hash tags keep both keys on the same Redis slot if clustered later.
    return [f"cart:{{{session_id}}}", f"lock:{{{session_id}}}"]


class Item(BaseModel):
    model_config = ConfigDict(extra="forbid")
    product_id: UUID
    quantity: int = Field(strict=True, ge=1, le=99)


class Quantity(BaseModel):
    model_config = ConfigDict(extra="forbid")
    quantity: int = Field(strict=True, ge=1, le=99)


class Freeze(BaseModel):
    token: UUID


class Finish(Freeze):
    version: int = Field(ge=0)
    clear: bool = False


async def get_raw(session_id):
    async with measured("cart-api", redis_target(), "basket.get"):
        await app.state.redis.set(keys(session_id)[0], '{"items":{},"version":0}', nx=True, ex=TTL)
        raw = await app.state.redis.get(keys(session_id)[0])
    return json.loads(raw) if raw else {"items": {}, "version": 0}


@app.get("/carts/{session_id}")
async def get_cart(session_id: UUID):
    raw = await get_raw(session_id)
    if not raw["items"]:
        return {"session_id": str(session_id), "items": [], "total_cents": 0, "currency": "GBP"}
    catalog = require_ok(await call(app, "GET", f"{PRODUCT_URL}/products"))
    products = {str(p["id"]): p for p in catalog}
    items = []
    for pid, qty in raw["items"].items():
        p = products.get(pid)
        if not p:
            raise HTTPException(409, "A basket product is no longer available; remove it")
        items.append({"product": p, "quantity": qty, "line_total_cents": qty * p["price_cents"]})
    return {"session_id": str(session_id), "items": items,
            "total_cents": sum(i["line_total_cents"] for i in items), "currency": "GBP"}


async def mutate(session_id, product_id, quantity, mode):
    stock = 99
    if quantity:
        p = require_ok(await call(app, "GET", f"{PRODUCT_URL}/products/{product_id}"), "Product unavailable")
        stock = p["stock"]
    async with measured("cart-api", redis_target(), "basket.mutate"):
        result = await app.state.redis.eval(MUTATE, 2, *keys(session_id), str(product_id), quantity, mode, TTL, stock)
    if result == -1:
        raise HTTPException(409, "Checkout is in progress; try again shortly")
    if result == -2:
        raise HTTPException(409, "Requested quantity exceeds availability or the 99 item limit")
    if result == -3:
        raise HTTPException(409, "Basket may contain at most 30 different products")
    # Do not require Product API for removal, including obsolete products.
    return {"updated": True}


@app.post("/carts/{session_id}/items")
async def add(session_id: UUID, item: Item):
    return await mutate(session_id, item.product_id, item.quantity, "add")


@app.put("/carts/{session_id}/items/{product_id}")
async def update(session_id: UUID, product_id: UUID, item: Quantity):
    return await mutate(session_id, product_id, item.quantity, "set")


@app.delete("/carts/{session_id}/items/{product_id}")
async def remove(session_id: UUID, product_id: UUID):
    return await mutate(session_id, product_id, 0, "set")


@app.post("/internal/carts/{session_id}/snapshot", dependencies=[Depends(internal)])
async def snapshot(session_id: UUID, body: Freeze):
    async with measured("cart-api", redis_target(), "basket.freeze"):
        raw = await app.state.redis.eval(SNAPSHOT, 2, *keys(session_id), str(body.token))
    if raw is None:
        raise HTTPException(409, "Basket is already being checked out; retry shortly")
    return json.loads(raw)


@app.post("/internal/carts/{session_id}/finish", dependencies=[Depends(internal)])
async def finish(session_id: UUID, body: Finish):
    async with measured("cart-api", redis_target(), "basket.finish"):
        await app.state.redis.eval(FINISH, 2, *keys(session_id), str(body.token), body.version,
                                   "clear" if body.clear else "release", TTL)
    return {"ok": True}
