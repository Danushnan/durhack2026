"""Continuous illustrative city traffic; never enters application metrics."""
import asyncio
import random
import time

import httpx


class AmbientTraffic:
    def __init__(self, city):
        self.city = city
        self.task = None
        self.lock = asyncio.Lock()
        self.state = {'running': False, 'rate': 1.0, 'sent': 0, 'error': None}

    async def configure(self, enabled, rate):
        async with self.lock:
            await self.stop()
            self.state.update(rate=rate, error=None)
            if enabled:
                self.state.update(running=True, sent=0)
                self.task = asyncio.create_task(self.run())
            return dict(self.state)

    async def stop(self):
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.task = None
        self.state['running'] = False

    async def run(self):
        try:
            async with httpx.AsyncClient(timeout=5) as client:
                while True:
                    started = time.monotonic()
                    response = await client.post(self.city + '/api/demo/packets', json={
                        'count': 1, 'cross_district': random.random() < .35, 'ambient': True})
                    response.raise_for_status()
                    self.state['sent'] += response.json()['sent']
                    await asyncio.sleep(max(0, 1 / self.state['rate'] - (time.monotonic() - started)))
        except Exception as exc:
            self.state['error'] = ('Open the city and wait for its live connection, then start again. '
                                   f'Traffic stopped: {type(exc).__name__}.')
        finally:
            self.state['running'] = False
