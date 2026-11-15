"""Bounded async adaptation of Person C's scripts/traffic.py; only real storefront HTTP."""
import asyncio
import time
from uuid import uuid4
import httpx


class Traffic:
    def __init__(self, base, refusal_target=None, show_refusal=None):
        self.base = base
        self.refusal_target = refusal_target
        self.show_refusal = show_refusal
        self.task = None
        self.state = {"running": False, "attempted": 0, "failed": 0, "checkouts": 0, "last_status": None, "error": None}

    def start(self, rps=1.0, requests=100):
        if self.task and not self.task.done():
            return False
        self.state = {"running": True, "attempted": 0, "failed": 0, "checkouts": 0,
                      "last_status": None, "error": None, "limit": requests, "rps": rps}
        self.task = asyncio.create_task(self.run(rps, requests))
        return True

    async def stop(self):
        if self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
        self.state["running"] = False

    async def run(self, rps, limit):
        try:
            await asyncio.wait_for(self._run(rps, limit), timeout=300)
        except TimeoutError:
            self.state['error'] = 'Five-minute safety limit reached'
        finally:
            self.state['running'] = False

    async def _run(self, rps, limit):
        session, products, basket = str(uuid4()), [], False
        deadline = time.monotonic() + 300
        try:
            async with httpx.AsyncClient(base_url=self.base, timeout=50, follow_redirects=False) as client:
                for tick in range(limit):
                    if time.monotonic() >= deadline:
                        break
                    started = time.monotonic()
                    method, path, body, headers = 'GET', '/api/products', None, {}
                    if tick % 5 == 1 and products:
                        product = products[(tick // 5) % len(products)]
                        method, path, body = 'POST', f'/api/carts/{session}/items', {"product_id": product['id'], "quantity": 1}
                    elif tick % 5 == 3 and basket and self.state['checkouts'] < 20:
                        method, path = 'POST', f'/api/checkout/{session}'
                        headers['Idempotency-Key'] = str(uuid4())
                        self.state['checkouts'] += 1
                    elif tick % 5 in (2, 4):
                        path = f'/api/carts/{session}'
                    self.state['attempted'] += 1
                    try:
                        response = await client.request(method, path, json=body,
                            headers={**headers, 'X-Request-ID': str(uuid4())})
                        self.state['last_status'] = response.status_code
                        response.raise_for_status()
                        if path == '/api/products':
                            products = [p for p in response.json() if p.get('stock', 0) > 0]
                        elif method == 'POST' and '/items' in path:
                            basket = True
                        self.state['error'] = None
                    except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
                        self.state['error'] = f'{type(exc).__name__}: storefront request failed'
                        if self.refusal_target and (isinstance(exc, httpx.RequestError) or
                                isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code in (502, 503, 504)):
                            try:
                                route = await self.refusal_target(path)
                                if route:
                                    self.state['failed'] += 1
                                    if self.show_refusal:
                                        await self.show_refusal(*route)
                            except (RuntimeError, httpx.HTTPError, ValueError):
                                self.state['error'] += '; could not verify Ready pods or notify the map'
                    finally:
                        if '/checkout/' in path:
                            # Never replay an ambiguous checkout with a fresh key.
                            session, basket = str(uuid4()), False
                    await asyncio.sleep(max(0, 1 / rps - (time.monotonic() - started)))
        finally:
            self.state['running'] = False
