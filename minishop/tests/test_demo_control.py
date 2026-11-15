"""Operator tests never invoke kubectl or mutate a cluster."""
import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock
from uuid import uuid4
import time

import httpx
import pytest
from demo_control.app import create_app, Controller, Action, Settings
from demo_control.traffic import Traffic

def settings(enabled=True):
    return SimpleNamespace(enabled=enabled, context='disposable-test', base='http://127.0.0.1:8080')


def observed(**changes):
    return {'delay_ms':100, 'rejection':False, 'checkout_replicas':1,
            'payment_ready':True, 'checkout_ready':True, **changes}


def test_api_permissions_and_limits():
    async def run():
        app = create_app(settings())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=('127.0.0.1', 123)), base_url='http://127.0.0.1') as c:
            assert (await c.get('/api/demo/status')).status_code == 200
            assert (await c.get('/api/demo/status', headers={'Origin':'https://evil.example'})).status_code == 403
            assert (await c.get('/api/demo/status', headers={'Host':'evil.example'})).status_code == 400
            assert (await c.post('/api/demo/actions', json={'action':'shell','command':'rm'})).status_code == 422
            assert (await c.post('/api/demo/actions', json={'action':'scale','replicas':4})).status_code == 422
            assert (await c.post('/api/demo/actions', json={'action':'scale','namespace':'other'})).status_code == 422
            assert (await c.post('/api/demo/traffic/start', json={'rps':21})).status_code == 422
            start = Mock(return_value=True)
            app.state.control.traffic.start = start
            assert (await c.post('/api/demo/traffic/start', json={'rps':20})).status_code == 200
            start.assert_called_once_with(20, 100)
            assert (await c.post('/api/demo/traffic/start', json={'requests':301})).status_code == 422
        disabled = create_app(settings(False))
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=disabled, client=('127.0.0.1',123)), base_url='http://127.0.0.1') as c:
            assert (await c.get('/api/demo/status')).status_code == 404
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, client=('10.0.0.1',123)), base_url='http://127.0.0.1') as c:
            assert (await c.get('/api/demo/status')).status_code == 403
    asyncio.run(run())


def test_verified_operations_and_repeated_reset():
    async def run():
        controller = Controller(settings())
        controller.script = AsyncMock()
        for name, expected in [('slowdown', {'delay_ms':2000}), ('restore-delay', {}), ('reject', {'rejection':True}), ('accept', {}), ('scale', {'checkout_replicas':2}), ('reset', {}), ('reset', {})]:
            controller.inspect = AsyncMock(return_value=observed(**expected))
            controller.start_action(Action(action=name, replicas=2))
            assert controller.operation['status'] == 'running'
            with pytest.raises(Exception): controller.start_action(Action(action=name))
            await controller.task
            assert controller.operation['status'] == 'succeeded'
        assert [call.args for call in controller.script.call_args_list[-3:]] == [('delay-payment', '100'), ('restore-payment',), ('scale', '1')]
        controller.inspect = AsyncMock(return_value=observed(delay_ms=100))
        await controller.run_action(Action(action='slowdown'))
        assert controller.operation['status'] == 'failed'
        controller.script = AsyncMock(side_effect=RuntimeError('rollout timeout'))
        await controller.run_action(Action(action='reset'))
        assert controller.script.call_count == 3
        assert controller.operation['status'] == 'failed'
        assert controller.verified is None
    asyncio.run(run())


def test_traffic_real_paths_idempotency_counts_and_stop(monkeypatch):
    async def run():
        paths = []
        real_client = httpx.AsyncClient
        def respond(request):
            paths.append(request)
            if request.url.path == '/api/products':
                return httpx.Response(200, json=[{'id':str(uuid4()), 'stock':100}])
            if '/checkout/' in request.url.path:
                assert request.headers.get('Idempotency-Key')
                return httpx.Response(402, json={'detail':'Rejected'})
            return httpx.Response(200, json={})
        monkeypatch.setattr('demo_control.traffic.httpx.AsyncClient', lambda **kw: real_client(**kw, transport=httpx.MockTransport(respond)))
        worker = Traffic('http://127.0.0.1:8080')
        assert worker.start(2, 5)
        original = worker.task
        assert not worker.start(2, 5)
        assert worker.task is original
        await worker.task
        assert len(paths) == worker.state['attempted'] == 5
        assert worker.state['failed'] == 1
        assert worker.state['refused'] == 0
        assert worker.state['checkouts'] == 1
        assert worker.state['running'] is False
        assert any('/carts/' in str(p.url) and p.method == 'POST' for p in paths)
        assert worker.start(2, 300)
        await asyncio.sleep(.01)
        await worker.stop()
        count = len(paths)
        await asyncio.sleep(.6)
        assert len(paths) == count
        assert not worker.state['running']
        await worker.stop()
    asyncio.run(run())


def test_traffic_counts_all_failures_but_displays_only_confirmed_pod_refusals(monkeypatch):
    async def run():
        real_client = httpx.AsyncClient
        replies = iter([402, 502, 503])
        transport = httpx.MockTransport(lambda _: httpx.Response(next(replies)))
        monkeypatch.setattr('demo_control.traffic.httpx.AsyncClient', lambda **kw: real_client(**kw, transport=transport))
        route = ('minishop/minishop-web', 'minishop/product-api')
        verify = AsyncMock(side_effect=[None, route])
        display = AsyncMock()
        worker = Traffic('http://127.0.0.1:8080', verify, display)
        worker.start(1000, 3)
        await worker.task
        assert worker.state['failed'] == 3
        assert worker.state['refused'] == 1
        assert verify.await_count == 2
        display.assert_awaited_once_with(*route)
    asyncio.run(run())


def test_refusal_target_requires_zero_ready_nonterminating_pods():
    def pod(app, ready, deleting=False):
        return {
            'metadata': {'labels': {'app': app}, 'deletionTimestamp': 'now' if deleting else None},
            'status': {'conditions': [{'type': 'Ready', 'status': 'True' if ready else 'False'}]},
        }

    async def run():
        controller = Controller(settings())
        web = pod('minishop-web', True)
        controller.command = AsyncMock(return_value=json.dumps({'items': [
            web, pod('product-api', False), pod('product-api', True, deleting=True),
        ]}))
        assert await controller.refusal_target('/api/products') == ('minishop/minishop-web', 'minishop/product-api')
        controller.command.return_value = json.dumps({'items': [web, pod('product-api', True)]})
        assert await controller.refusal_target('/api/products') is None
    asyncio.run(run())


def test_payment_api_actual_delay_rejection_and_recovery(monkeypatch):
    # Real existing payment handler, no database or Kubernetes changes.
    from services.payments.app import app
    monkeypatch.setenv('INTERNAL_TOKEN', 'test-payment-token')
    payload = {'session_id':str(uuid4()), 'idempotency_key':str(uuid4()), 'amount_cents':100, 'currency':'GBP'}
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://payment') as c:
            timings = []
            for delay in ('100', '2000', '100'):
                monkeypatch.setenv('PAYMENT_DELAY_MS',delay)
                monkeypatch.setenv('PAYMENT_FAIL','false')
                start = time.monotonic()
                r = await c.post('/payments', json=payload, headers={'X-Internal-Token':'test-payment-token'})
                timings.append(time.monotonic()-start)
                assert r.status_code == 200
            assert timings[1] >= 2
            assert timings[0] < 1 and timings[2] < 1
            monkeypatch.setenv('PAYMENT_FAIL','true')
            assert (await c.post('/payments', json=payload, headers={'X-Internal-Token':'test-payment-token'})).status_code == 402
            monkeypatch.setenv('PAYMENT_FAIL','false')
            assert (await c.post('/payments', json=payload, headers={'X-Internal-Token':'test-payment-token'})).status_code == 200
    asyncio.run(run())


def test_script_boundary_and_readback(monkeypatch):
    async def run():
        commands=[]
        def execute(args, **kw):
            commands.append((args,kw))
            assert kw.get('shell') is None
            return SimpleNamespace(returncode=0, stdout='', stderr='')
        monkeypatch.setattr('subprocess.run',execute)
        control=Controller(settings())
        await control.script('scale','3')
        assert commands[0][0][-2:] == ['scale','3']
        assert commands[0][1]['env']['MINISHOP_CONTEXT'] == 'disposable-test'
        await control.command('get','deployment','payment-api','-o','json')
        assert commands[1][0][:5] == ['kubectl','--context','disposable-test','-n','minishop']
    asyncio.run(run())


def test_generator_against_real_minishop_http_services(stack):
    """A local HTTP forwarding adapter replaces only Nginx, never application handlers/data stores."""
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    urls = stack['urls']
    original_checkout = urls['checkout']
    requests = []
    class Forward(BaseHTTPRequestHandler):
        def log_message(self, *args): pass
        def forward(self):
            path = self.path.removeprefix('/api')
            service = 'products' if path.startswith('/products') else 'cart' if path.startswith('/carts') else 'checkout'
            data = self.rfile.read(int(self.headers.get('Content-Length', 0)))
            headers = {k:v for k,v in self.headers.items() if k.lower() in ('content-type','idempotency-key','x-request-id')}
            headers['X-Source-Service'] = 'minishop-web'
            response = httpx.request(self.command, urls[service] + path, content=data, headers=headers, timeout=50)
            requests.append((self.command, path, response.status_code))
            self.send_response(response.status_code)
            self.send_header('Content-Type','application/json')
            self.end_headers(); self.wfile.write(response.content)
        do_GET = forward
        do_POST = forward
    server = ThreadingHTTPServer(('127.0.0.1', 0), Forward)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    async def run():
        worker = Traffic(f'http://127.0.0.1:{server.server_port}')
        worker.start(2,5)
        await worker.task
        assert worker.state['attempted'] == 5
        assert worker.state['failed'] == 0
        assert worker.state['refused'] == 0
        assert any('/checkout/' in path and code == 200 for _,path,code in requests)
        # Swap to the existing rejecting real checkout process, not a fake HTTP 402.
        urls['checkout'] = urls['failed-checkout']
        worker.start(2,5)
        await worker.task
        assert worker.state['failed'] == 1
        assert any('/checkout/' in path and code == 402 for _,path,code in requests)
    try: asyncio.run(run())
    finally:
        urls['checkout'] = original_checkout
        server.shutdown(); server.server_close(); thread.join(timeout=2)


def test_effective_environment_readback_does_not_expose_secrets():
    import json
    async def run():
        control = Controller(settings())
        def deployment(name):
            return {'metadata': {'generation':2}, 'spec': {'replicas':1, 'template': {'spec': {'containers': [
                {'name':'workload', 'envFrom':[{'configMapRef':{'name':'minishop-config'}}],
                 'env':[{'name':'INTERNAL_TOKEN','valueFrom':{'secretKeyRef':{'name':'secret','key':'token'}}}]}]}}},
                'status': {'observedGeneration':2, 'replicas':1, 'updatedReplicas':1, 'availableReplicas':1}}
        async def command(*args):
            if args[1] == 'configmap':
                return json.dumps({'data':{'PAYMENT_DELAY_MS':'2000','PAYMENT_FAIL':'true'}})
            return json.dumps(deployment(args[2]))
        control.command = command
        value = await control.inspect()
        assert value['delay_ms'] == 2000
        assert value['rejection'] is True
        assert 'INTERNAL_TOKEN' not in str(value)
    asyncio.run(run())
