"""Local-only MiniShop operator. Run one uvicorn worker; disabled unless explicitly enabled."""
import asyncio
import ipaddress
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
    rps: float = Field(default=1, ge=.2, le=2, allow_inf_nan=False)
    requests: int = Field(default=100, ge=5, le=300, strict=True)


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
        self.traffic = Traffic(settings.base)
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

    async def script(self, *args):
        def run():
            result = subprocess.run(['bash', str(ROOT / 'scripts/demo.sh'), *args], cwd=ROOT,
                env={**os.environ, 'MINISHOP_CONTEXT': self.settings.context},
                capture_output=True, text=True, timeout=140, check=False)
            if result.returncode:
                raise RuntimeError('Demo action failed: ' + result.stderr[-1500:])
        await asyncio.to_thread(run)

    async def inspect(self):
        import json
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
                for args in [('delay-payment', '100'), ('restore-payment',), ('scale', '1')]:
                    try:
                        await self.script(*args)
                    except Exception as exc:
                        errors.append(str(exc))
                if errors:
                    raise RuntimeError('; '.join(errors))
            elif body.action == 'slowdown': await self.script('delay-payment', '2000')
            elif body.action == 'restore-delay': await self.script('delay-payment', '100')
            elif body.action == 'reject': await self.script('fail-payment')
            elif body.action == 'accept': await self.script('restore-payment')
            elif body.action == 'scale': await self.script('scale', str(body.replicas))
            observed = await self.inspect()
            expected = {'slowdown': {'delay_ms': 2000}, 'restore-delay': {'delay_ms': 100},
                        'reject': {'rejection': True}, 'accept': {'rejection': False},
                        'scale': {'checkout_replicas': body.replicas},
                        'reset': {'delay_ms': 100, 'rejection': False, 'checkout_replicas': 1}}.get(body.action, {})
            if body.action != 'inspect' and (not observed['payment_ready'] or not observed['checkout_ready'] or
                any(observed[k] != v for k, v in expected.items())):
                raise RuntimeError('Rollout/configuration verification failed; inspect the demo cluster')
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
