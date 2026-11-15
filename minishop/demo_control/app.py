"""Local-only MiniShop operator. Run one uvicorn worker; disabled unless explicitly enabled."""
import asyncio
import ipaddress
import json
import os
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Literal
from urllib.parse import urlsplit

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field
from starlette.middleware.trustedhost import TrustedHostMiddleware
from .traffic import Traffic

ROOT = Path(__file__).resolve().parents[1]


def local_url(value):
    url = urlsplit(value)
    if url.scheme != 'http' or url.hostname not in ('localhost', '127.0.0.1', '::1') or url.username or url.password or url.query or url.fragment or url.path not in ('', '/') or url.port == 8090:
        raise RuntimeError('Storefront must be a fixed localhost HTTP URL')
    return value.rstrip('/')


class Settings:
    def __init__(self):
        self.enabled = os.getenv('MINISHOP_DEMO_ENABLED') == '1'
        self.context = os.getenv('MINISHOP_CONTEXT', '')
        self.base = local_url(os.getenv('MINISHOP_DEMO_SHOP_URL', 'http://127.0.0.1:8080'))
        self.city = local_url(os.getenv('MINISHOP_DEMO_CITY_URL', 'http://127.0.0.1:8000'))
        if self.enabled and (not self.context or self.context.startswith('-')):
            raise RuntimeError('Demo requires explicit MINISHOP_CONTEXT')


class Start(BaseModel):
    model_config = ConfigDict(extra='forbid')
    rps: float = Field(default=1, ge=.2, le=20, allow_inf_nan=False)
    requests: int | None = Field(default=100, ge=5, le=300, strict=True)


class Packets(BaseModel):
    model_config = ConfigDict(extra='forbid')
    count: int = Field(ge=1, le=100, strict=True)
    cross_district: bool = Field(strict=True)


class Action(BaseModel):
    model_config = ConfigDict(extra='forbid')
    action: Literal['slowdown', 'restore-delay', 'reject', 'accept', 'reset', 'scale', 'inspect']
    replicas: int = Field(default=1, ge=1, le=3, strict=True)


class Controller:
    def __init__(self, settings):
        self.settings = settings
        self.traffic = Traffic(settings.base, self.refusal_target, self.show_refusal)
        self.task = None
        self.operation = None
        self.verified = None

    async def command(self, *args):
        # No shell, no user-provided executable or arguments. Fixed context and namespace.
        def run():
            result = subprocess.run(['kubectl', '--context', self.settings.context, '-n', 'minishop', *args],
                                    capture_output=True, text=True, timeout=135, check=False)
            if result.returncode:
                raise RuntimeError('Kubernetes action failed: ' + result.stderr[-1500:])
            return result.stdout
        return await asyncio.to_thread(run)

    async def set_payment(self, setting):
        deployment = 'deployment/payment-api'
        await self.command('set', 'env', deployment, setting)
        await self.command('rollout', 'status', deployment, '--timeout=120s')

    async def scale_checkout(self, replicas):
        deployment = 'deployment/checkout-api'
        await self.command('scale', deployment, f'--replicas={replicas}')
        await self.command('rollout', 'status', deployment, '--timeout=120s')

    async def inspect(self):
        deployments = {}
        config = json.loads(await self.command('get', 'configmap', 'minishop-config', '-o', 'json')).get('data', {})
        for name in ('payment-api', 'checkout-api'):
            dep = json.loads(await self.command('get', 'deployment', name, '-o', 'json'))
            spec, status = dep['spec'], dep.get('status', {})
            ready = (status.get('observedGeneration', 0) >= dep['metadata']['generation'] and
                     status.get('updatedReplicas', 0) == spec['replicas'] and
                     status.get('availableReplicas', 0) == spec['replicas'] and
                     status.get('replicas', 0) == spec['replicas'])
            env = {}
            for container in spec['template']['spec']['containers']:
                if container['name'] != 'workload':
                    continue
                for source in container.get('envFrom', []):
                    if source.get('configMapRef', {}).get('name') != 'minishop-config' or source.get('prefix'):
                        raise RuntimeError('Cannot verify payment settings from an unsupported environment source')
                    env.update(config)
                for entry in container.get('env', []):
                    if entry['name'] in ('PAYMENT_DELAY_MS', 'PAYMENT_FAIL') and 'value' not in entry:
                        raise RuntimeError('Cannot verify indirect payment environment values')
                    env[entry['name']] = entry.get('value')
            deployments[name] = {'replicas': spec['replicas'], 'ready': ready, 'env': env}
        # Return no unrelated deployment environment or credentials to the browser.
        payment = deployments['payment-api']
        return {'delay_ms': int(payment['env'].get('PAYMENT_DELAY_MS') or '100'),
                'rejection': (payment['env'].get('PAYMENT_FAIL') or 'false').lower() == 'true',
                'payment_ready': payment['ready'], 'checkout_ready': deployments['checkout-api']['ready'],
                'checkout_replicas': deployments['checkout-api']['replicas'], 'checked_at': time.time()}

    async def refusal_target(self, path):
        upstream = {'products': 'product-api', 'carts': 'cart-api', 'checkout': 'checkout-api'}[path.split('/')[2]]
        pods = json.loads(await self.command('get', 'pods', '-l', f'app in (minishop-web,{upstream})', '-o', 'json'))
        ready = {
            pod['metadata'].get('labels', {}).get('app') for pod in pods['items']
            if not pod['metadata'].get('deletionTimestamp') and
            any(c['type'] == 'Ready' and c['status'] == 'True' for c in pod.get('status', {}).get('conditions', []))
        }
        if 'minishop-web' not in ready:
            return 'demo-transit/depot', 'minishop/minishop-web'
        if upstream not in ready:
            return 'minishop/minishop-web', f'minishop/{upstream}'
        return None

    async def show_refusal(self, source, target):
        async with httpx.AsyncClient(timeout=5, follow_redirects=False) as client:
            response = await client.post(self.settings.city + '/api/demo/packets/refusal',
                                         json={'source': source, 'target': target, 'context': self.settings.context})
            response.raise_for_status()

    def start_action(self, body):
        if self.task and not self.task.done():
            raise HTTPException(409, 'An operation is already running. Follow its status before retrying.')
        self.operation = {'action': body.action, 'status': 'running', 'message': 'Waiting for verified configuration and rollout'}
        self.task = asyncio.create_task(self.run_action(body))

    async def run_action(self, body):
        try:
            if body.action == 'reset':
                await self.traffic.stop()
                # Attempt every restoration even if a preceding action fails.
                errors = []
                for action, value in [(self.set_payment, 'PAYMENT_DELAY_MS=100'),
                                      (self.set_payment, 'PAYMENT_FAIL=false'),
                                      (self.scale_checkout, 1)]:
                    try:
                        await action(value)
                    except Exception as exc:
                        errors.append(str(exc))
                if errors:
                    raise RuntimeError('; '.join(errors))
            elif body.action == 'slowdown': await self.set_payment('PAYMENT_DELAY_MS=2000')
            elif body.action == 'restore-delay': await self.set_payment('PAYMENT_DELAY_MS=100')
            elif body.action == 'reject': await self.set_payment('PAYMENT_FAIL=true')
            elif body.action == 'accept': await self.set_payment('PAYMENT_FAIL=false')
            elif body.action == 'scale': await self.scale_checkout(body.replicas)
            observed = await self.inspect()
            expected = {'slowdown': {'delay_ms': 2000}, 'restore-delay': {'delay_ms': 100},
                        'reject': {'rejection': True}, 'accept': {'rejection': False},
                        'scale': {'checkout_replicas': body.replicas},
                        'reset': {'delay_ms': 100, 'rejection': False, 'checkout_replicas': 1}}.get(body.action, {})
            if body.action in {'slowdown', 'restore-delay', 'reject', 'accept', 'reset'} and not observed['payment_ready']:
                raise RuntimeError('Payment rollout is not ready')
            if body.action in {'scale', 'reset'} and not observed['checkout_ready']:
                raise RuntimeError('Checkout rollout is not ready')
            if any(observed[k] != v for k, v in expected.items()):
                raise RuntimeError('The running configuration differs from the requested settings')
            self.verified = observed
            self.operation.update(status='succeeded', message='Configuration read back from Kubernetes; rollout verified' if body.action != 'inspect' else 'Configuration read back from Kubernetes')
        except Exception as exc:
            self.verified = None
            self.operation.update(status='failed', message=str(exc))


def create_app(settings=None):
    settings = settings or Settings()
    control = Controller(settings)

    @asynccontextmanager
    async def lifespan(app):
        yield
        await control.traffic.stop()
        # Let an accepted rollout complete, rather than abandoning an in-flight restoration.
        if control.task:
            await control.task

    app = FastAPI(title='MiniShop Demo Control', lifespan=lifespan)
    app.state.control = control
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=['localhost', '127.0.0.1', '[::1]'])

    def require_local_demo(request: Request):
        if not settings.enabled:
            raise HTTPException(404, 'Demo controls are disabled')
        try:
            local = ipaddress.ip_address(request.client.host).is_loopback
        except ValueError:
            local = False
        origin = request.headers.get('origin')
        if not local or (origin and urlsplit(origin).hostname not in ('localhost', '127.0.0.1', '::1')):
            raise HTTPException(403, 'Local operator access only')

    @app.get('/api/demo/status', dependencies=[Depends(require_local_demo)])
    async def status():
        return {'traffic': control.traffic.state, 'operation': control.operation, 'verified': control.verified,
                'namespace': 'minishop', 'context': settings.context}

    @app.post('/api/demo/traffic/start', dependencies=[Depends(require_local_demo)])
    async def start(body: Start):
        if control.task and not control.task.done():
            raise HTTPException(409, 'Wait for the current operation before starting traffic')
        created = control.traffic.start(body.rps, body.requests)
        return {'started': created, 'traffic': control.traffic.state}

    @app.post('/api/demo/traffic/stop', dependencies=[Depends(require_local_demo)])
    async def stop():
        await control.traffic.stop()
        return {'traffic': control.traffic.state}

    @app.post('/api/demo/actions', status_code=202, dependencies=[Depends(require_local_demo)])
    async def action(body: Action):
        control.start_action(body)
        return control.operation

    async def forward_packets(path, body=None):
        try:
            async with httpx.AsyncClient(timeout=5, follow_redirects=False) as client:
                response = await client.post(settings.city + path, json=body)
                result = response.json()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(502, 'Kuebec is unavailable. Check that the map and backend are running.')
        if not response.is_success:
            raise HTTPException(response.status_code, result.get('detail', 'Kuebec could not deliver the demo command.'))
        return result

    @app.post('/api/demo/packets', dependencies=[Depends(require_local_demo)])
    async def send_packets(body: Packets):
        return await forward_packets('/api/demo/packets', body.model_dump())

    @app.post('/api/demo/packets/reset', dependencies=[Depends(require_local_demo)])
    async def reset_packets():
        return await forward_packets('/api/demo/packets/reset')

    @app.api_route('/api/{path:path}', methods=['GET', 'POST', 'PUT', 'DELETE'])
    async def storefront(path: str, request: Request):
        # Forward only headers used by the storefront API.
        if path.split('/')[0] not in ('products', 'carts', 'checkout', 'orders') or '..' in path or '//' in path:
            raise HTTPException(404)
        data = await request.body()
        if len(data) > 16384:
            raise HTTPException(413)
        headers = {k: v for k, v in request.headers.items() if k.lower() in ('content-type', 'x-request-id', 'idempotency-key')}
        try:
            async with httpx.AsyncClient(timeout=55, follow_redirects=False) as client:
                response = await client.request(request.method, settings.base + '/api/' + path,
                    params=request.query_params, content=data, headers=headers)
            return Response(response.content, response.status_code, headers={k: v for k, v in response.headers.items()
                if k.lower() in ('content-type', 'x-request-id', 'x-served-by')})
        except httpx.HTTPError:
            raise HTTPException(502, 'MiniShop storefront is unavailable')

    dist = ROOT / 'frontend/dist'
    if dist.is_dir():
        app.mount('/', StaticFiles(directory=dist, html=True), name='minishop')
    return app


app = create_app()
