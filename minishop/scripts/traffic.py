#!/usr/bin/env python3
"""Exercise the running MiniShop storefront and its backing services."""
import argparse
import json
import time
from urllib.error import URLError
from urllib.request import Request, urlopen
from uuid import uuid4


def run(base, limit):
    def request(path, method="GET", body=None, **headers):
        req = Request(
            f"{base.rstrip('/')}/api{path}", method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json", "X-Request-ID": str(uuid4()), **headers},
        )
        with urlopen(req, timeout=5) as response:
            return json.load(response)

    session = str(uuid4())
    last_checkout = session
    basket_ready = False
    products = []
    tick = 0
    while limit is None or tick < limit:
        started = time.monotonic()
        tick += 1
        try:
            if tick % 5 == 1 or not products:
                products = request("/products")
                action = "catalogue"
            elif tick % 5 == 2 and products:
                product = products[(tick // 5) % len(products)]
                request(f"/carts/{session}/items", "POST", {"product_id": product["id"], "quantity": 1})
                basket_ready = True
                action = "add to basket"
            elif tick % 5 == 4 and basket_ready:
                action = "checkout"
                try:
                    request(f"/checkout/{session}", "POST", **{"Idempotency-Key": str(uuid4())})
                finally:
                    last_checkout = session
                    session = str(uuid4())
                    basket_ready = False
            else:
                request(f"/carts/{session}" if tick % 5 != 0 else f"/orders/{last_checkout}")
                action = "read basket or orders"
            print(f"{tick}: {action} OK", flush=True)
        except (URLError, TimeoutError, ValueError, KeyError) as error:
            print(f"{tick}: {error}", flush=True)
        if limit is None or tick < limit:
            time.sleep(max(0, 1 - (time.monotonic() - started)))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:8080", help="MiniShop storefront URL")
    parser.add_argument("--count", type=int, help="Stop after this many requests")
    args = parser.parse_args()
    try:
        run(args.base, args.count)
    except KeyboardInterrupt:
        pass
