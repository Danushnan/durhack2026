#!/usr/bin/env python3
"""Real HTTP smoke test through the same proxy URL used by the browser."""
import argparse
import json
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--base", default="http://localhost:8080")
    parser.add_argument("--expect-payment-failure", action="store_true")
    args = parser.parse_args()
    session, key, request_id = (str(uuid4()) for _ in range(3))

    def call(path, method="GET", body=None, expected=200, checkout=False):
        headers = {"Content-Type": "application/json", "X-Request-ID": request_id}
        if checkout:
            headers["Idempotency-Key"] = key
        req = Request(args.base.rstrip('/') + "/api" + path, method=method, headers=headers,
                      data=json.dumps(body).encode() if body is not None else None)
        for attempt in range(5 if checkout else 1):
            try:
                response = urlopen(req, timeout=60)
            except HTTPError as exc:
                response = exc
            raw = response.read()
            if checkout and response.status in (502, 503, 504) and attempt < 4:
                print(f"Transient checkout HTTP {response.status}; retrying the SAME idempotency key")
                time.sleep(.5)
                continue
            try:
                data = json.loads(raw)
            except ValueError:
                raise AssertionError((path, response.status, raw[:200])) from None
            break
        assert response.status == expected, (path, response.status, data)
        assert response.headers.get("X-Request-ID") == request_id, "Request ID was lost at the proxy"
        return data

    products = call("/products")
    assert len(products) >= 8
    p = products[0]
    assert call(f"/products/{p['id']}")["id"] == p["id"]
    call(f"/carts/{session}/items", "POST", {"product_id": p["id"], "quantity": 1})
    call(f"/carts/{session}/items/{p['id']}", "PUT", {"quantity": 2})
    assert call(f"/carts/{session}")["total_cents"] == p["price_cents"] * 2
    if args.expect_payment_failure:
        call(f"/checkout/{session}", "POST", expected=402, checkout=True)
        assert call(f"/orders/{session}") == []
        assert call(f"/carts/{session}")["items"]
        print(f"PASS: real payment decline; no order; basket retained. Request {request_id}")
    else:
        order = call(f"/checkout/{session}", "POST", checkout=True)
        assert order["total_cents"] == p["price_cents"] * 2
        assert order["basket_cleared"] and order["payment_reference"].startswith("sim_")
        assert call(f"/checkout/{session}", "POST", checkout=True)["id"] == order["id"]
        assert call(f"/orders/{session}")[0]["id"] == order["id"]
        assert call(f"/carts/{session}")["items"] == []
        print(f"PASS: checkout, saved order {order['id']}, idempotent replay and basket clear. Request {request_id}")
    print(f"Guest session: {session}")


if __name__ == "__main__":
    main()
