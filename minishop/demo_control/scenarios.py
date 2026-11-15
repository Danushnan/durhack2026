"""Three local demos, using the existing storefront and Kubernetes controller."""
import asyncio
import math
import time
from collections import deque
from uuid import uuid4

import httpx
from fastapi import HTTPException


async def shopping_order(client, steps, request_id):
    session = str(uuid4())
    async def send(label, method, path, **kwargs):
        started = time.monotonic()
        response = await client.request(method, path, **kwargs)
        steps.append({'label': label, 'status': response.status_code,
                      'ms': round((time.monotonic() - started) * 1000)})
        response.raise_for_status()
        return response.json()
    products = await send('Browse products', 'GET', '/api/products')
    product = next((p for p in products if p.get('stock', 0) > 0), None)
    if not product:
        raise RuntimeError('No available products')
    await send('Add to basket', 'POST', f'/api/carts/{session}/items',
               json={'product_id': product['id'], 'quantity': 1})
    return await send('Checkout', 'POST', f'/api/checkout/{session}',
                      headers={'Idempotency-Key': str(uuid4()), 'X-Request-ID': request_id})


def summary(rows):
    values = sorted(row[1] for row in rows)
    n = len(values)
    return {'samples': n, 'rps': round(n / 10, 2),
            'average_ms': round(sum(values) / n) if n else None,
            'p95_ms': round(values[max(0, math.ceil(n * .95) - 1)]) if n else None,
            'successful': sum(row[2] for row in rows), 'failed': sum(not row[2] for row in rows)}


class Scenarios:
    def __init__(self, control):
        self.control = control
        self.state = {'active': None, 'phase': 'idle', 'message': 'Choose a demo.', 'steps': [], 'result': None}
        self.load = None
        self.samples = deque(maxlen=2000)
        self.arrivals = deque(maxlen=2000)
        self.inflight = set()
        self.started = 0
        self.scaled_at = None
        self.before = None
        self.original = None
        self.sent = self.skipped = 0

    def metrics(self):
        now = time.monotonic()
        current = summary([r for r in self.samples if r[0] > max(self.started, self.scaled_at or 0, now - 10) and (not self.scaled_at or r[3] >= self.scaled_at)])
        current['incoming_rps'] = round(sum(t > max(self.started, self.scaled_at or 0, now - 10) for t in self.arrivals) / 10, 2)
        comparable = self.before and now - (self.scaled_at or now) >= 10 and current['samples'] >= 20
        improved = bool(comparable and self.before['samples'] >= 20 and
                        current['failed'] / current['samples'] <= self.before['failed'] / self.before['samples'] and
                        current['average_ms'] < self.before['average_ms'] * .8 and
                        current['incoming_rps'] >= self.before['incoming_rps'] * .9 and
                        current['incoming_rps'] <= self.before['incoming_rps'] * 1.1)
        return {**current, 'target_rps': 6, 'sent': self.sent, 'skipped': self.skipped,
                'elapsed': round(now - self.started) if self.started else 0, 'scaled': self.scaled_at is not None,
                'running': bool(self.load and not self.load.done()), 'before': self.before,
                'comparison': 'Measured latency improved at comparable incoming customer traffic.' if improved else
                'Collecting comparable measurements; improvement not yet demonstrated.'}

    def start(self, action, request_id):
        c = self.control
        if c.task and not c.task.done():
            raise HTTPException(409, 'Wait for the current operation to finish.')
        if self.state['active'] == 'rush' and action not in ('scale', 'reset'):
            raise HTTPException(409, 'Stop Rush Hour / Reset before another demo.')
        if action == 'scale' and (self.state['active'] != 'rush' or not self.metrics()['running']):
            raise HTTPException(409, 'Start Rush Hour first.')
        c.operation = {'action': action, 'status': 'running', 'message': 'Working…'}
        c.task = asyncio.create_task(self.run(action, request_id))

    async def restore(self):
        c = self.control
        if self.load:
            self.load.cancel()
            await asyncio.gather(self.load, return_exceptions=True)
        await c.traffic.stop()
        # Attempt all restorations even if one rollout fails. Retain baseline for retry.
        errors = []
        actions = [c.set_payment('PAYMENT_FAIL=false'), c.set_payment('PAYMENT_DELAY_MS=100')]
        if self.original:
            replicas, env = self.original
            args = [f'{key}={env[key]}' if key in env else f'{key}-'
                    for key in ('KUBEVERSE_DEMO_CAPACITY', 'KUBEVERSE_DEMO_WORK_MS')]
            async def checkout():
                await c.command('set', 'env', 'deployment/checkout-api', *args)
                await c.scale_checkout(replicas)
            actions.append(checkout())
        for action in actions:
            try:
                await action
            except Exception as exc:
                errors.append(str(exc))
        if errors:
            raise RuntimeError('; '.join(errors))
        c.verified = await c.inspect()
        if (not c.verified['payment_ready'] or not c.verified['checkout_ready'] or
                c.verified['rejection'] or c.verified['delay_ms'] != 100 or
                self.original and c.verified['checkout_replicas'] != self.original[0]):
            raise RuntimeError('Restoration could not be verified. Retry Reset.')
        self.original = None

    async def run(self, action, request_id):
        c = self.control
        try:
            self.state.update(phase='running', message='Waiting for rollout and real HTTP responses…')
            if action == 'reset':
                await self.restore()
                self.state.update(active=None, phase='idle', message='Reset complete. Ready for another demo.', steps=[], result=None)
            elif action == 'scale':
                if time.monotonic() - self.started < 10:
                    raise RuntimeError('Allow at least 10 seconds of load before scaling.')
                if self.scaled_at is not None:
                    raise RuntimeError('Checkout is already scaled. Reset before another comparison.')
                self.before = {key: value for key, value in self.metrics().items() if key not in ('before', 'comparison')}
                await c.scale_checkout(3)
                c.verified = await c.inspect()
                if not c.verified['checkout_ready'] or c.verified['checkout_replicas'] != 3:
                    raise RuntimeError('Three Checkout replicas are not ready.')
                self.scaled_at = time.monotonic()
                self.state.update(phase='running', message='Three replicas ready. Load continues at the same target; collecting new measurements.')
            else:
                await c.traffic.stop()
                self.state.update(active=action, steps=[], result=None, request_id=request_id)
                await c.set_payment('PAYMENT_DELAY_MS=100')
                await c.set_payment('PAYMENT_FAIL=' + ('true' if action == 'failure' else 'false'))
                c.verified = await c.inspect()
                if not c.verified['payment_ready'] or c.verified['rejection'] != (action == 'failure'):
                    raise RuntimeError('Payment configuration could not be verified.')
                if action == 'rush':
                    import json
                    dep = json.loads(await c.command('get', 'deployment', 'checkout-api', '-o', 'json'))
                    containers = dep['spec']['template']['spec']['containers']
                    env = next(item for item in containers if item['name'] == 'workload').get('env', [])
                    keys = ('KUBEVERSE_DEMO_CAPACITY', 'KUBEVERSE_DEMO_WORK_MS')
                    if any(e['name'] in keys and 'value' not in e for e in env):
                        raise RuntimeError('Demo capacity must use literal environment values.')
                    if not self.original:
                        self.original = (dep['spec']['replicas'], {e['name']: e['value'] for e in env if e['name'] in keys})
                    await c.command('set', 'env', 'deployment/checkout-api', 'KUBEVERSE_DEMO_CAPACITY=2', 'KUBEVERSE_DEMO_WORK_MS=600')
                    await c.scale_checkout(1)
                    c.verified = await c.inspect()
                    if not c.verified['checkout_ready']:
                        raise RuntimeError('Checkout rollout is not ready.')
                    self.samples.clear()
                    self.arrivals.clear()
                    self.sent = self.skipped = 0
                    self.before = self.scaled_at = None
                    self.started = time.monotonic()
                    self.load = asyncio.create_task(self.rush())
                    self.state.update(message='Rush Hour running: target 6 checkouts/s, maximum 24 concurrent customers.')
                else:
                    self.state.update(phase='requesting', message='Following a real checkout. Watch the city…')
                    # Let the paired city register correlation after configuration rollouts, not before.
                    await asyncio.sleep(3)
                    try:
                        async with httpx.AsyncClient(base_url=c.settings.base, timeout=50) as client:
                            result = await shopping_order(client, self.state['steps'], request_id)
                        if action == 'failure':
                            raise RuntimeError('Payment unexpectedly succeeded; rejection was not demonstrated.')
                        self.state.update(phase='completed', result=result, message='Order confirmed by the real Checkout API.')
                    except httpx.HTTPStatusError as exc:
                        if action != 'failure' or exc.response.status_code != 402:
                            raise
                        self.state.update(phase='completed', result={'http_status': 402, 'detail': exc.response.json().get('detail')},
                                          message='Payment rejected (HTTP 402). No order was confirmed; this is an application outcome, not a Pod outage.')
                    finally:
                        if action == 'failure':
                            await c.set_payment('PAYMENT_FAIL=false')
                            c.verified = await c.inspect()
                            if not c.verified['payment_ready'] or c.verified['rejection']:
                                raise RuntimeError('Payment acceptance restoration could not be verified. Press Reset.')
            c.operation.update(status='succeeded', message=self.state['message'])
        except Exception as exc:
            self.state.update(phase='failed', message=str(exc))
            c.operation.update(status='failed', message=str(exc))

    async def rush(self):
        async def customer(client):
            steps = []
            ok = False
            started = time.monotonic()
            try:
                await shopping_order(client, steps, str(uuid4()))
                ok = True
            except asyncio.CancelledError:
                return
            except Exception:
                pass
            finally:
                # Checkout timings are actual HTTP response times, including server queueing.
                checkout = next((s for s in steps if s['label'] == 'Checkout'), None)
                if not asyncio.current_task().cancelling():
                    self.samples.append((time.monotonic(), checkout['ms'] if checkout else round((time.monotonic() - started) * 1000), ok, started))
        try:
            async with httpx.AsyncClient(base_url=self.control.settings.base, timeout=15,
                                         limits=httpx.Limits(max_connections=48)) as client:
                deadline = self.started + 180
                tick = self.started
                while time.monotonic() < deadline:
                    if len(self.inflight) < 24:
                        task = asyncio.create_task(customer(client))
                        self.inflight.add(task)
                        task.add_done_callback(self.inflight.discard)
                        self.sent += 1
                        self.arrivals.append(time.monotonic())
                    else:
                        self.skipped += 1
                    tick += 1 / 6
                    await asyncio.sleep(max(0, tick - time.monotonic()))
                self.state.update(phase='completed', message='Three-minute load limit reached. Press Reset to restore the deployment.')
        except Exception as exc:
            self.state.update(phase='failed', message=f'Load stopped: {exc}. Press Reset.')
        finally:
            tasks = list(self.inflight)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
