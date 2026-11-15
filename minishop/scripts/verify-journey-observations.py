"""Opt-in real-HTTP verification against the disposable kv-journey-education stack.

Never changes Docker/Kubernetes configuration or payment settings. Test setup must
select the desired Payment profile beforehand. Creates simulated orders/baskets.
"""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time
from uuid import uuid4

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'backend'))
from checkout_journey import reconstruct_checkout
from journeys import Action
from live_telemetry import LiveTelemetry, parse_log

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--outcome', choices=('success','slow','decline','unavailable'), default='success')
args = parser.parse_args()
base = 'http://127.0.0.1:18080'
engine = LiveTelemetry('local-compose-verification')
services = ('minishop-web','product-api','cart-api','checkout-api','payment-api')


def collect(action):
    rows = []
    for name in services:
        container = 'kv-journey-education-' + name + '-1'
        identity = subprocess.run(['docker','inspect','--format','{{.Id}}',container],capture_output=True,text=True,check=True).stdout.strip()
        logs = subprocess.run(['docker','logs','--timestamps','--since','2m',container],capture_output=True,text=True,check=True)
        for line in (logs.stdout + '\n' + logs.stderr).splitlines():
            row = parse_log(line,namespace='minishop',deployment=name,pod_uid=identity,pod=container)
            if row:
                rows.append(row)
    engine.ingest(rows,time.time())
    selected,truncated = engine.request_observations({str(action.request_id)},time.time()-60,time.time(),128)
    return reconstruct_checkout(selected,action,'minishop',True,truncated)


with httpx.Client(timeout=25) as client:
    session,key = str(uuid4()),str(uuid4())
    product = client.get(base+'/api/products').json()[0]
    added = client.post(base+'/api/carts/'+session+'/items',json={'product_id':product['id'],'quantity':1})
    added.raise_for_status()

    def submit():
        action = Action(kind='checkout',action_id=uuid4(),request_id=uuid4())
        response = client.post(base+'/api/checkout/'+session,headers={'Idempotency-Key':key,'X-Request-ID':str(action.request_id)})
        action = action.model_copy(update={'checkout':'succeeded' if response.is_success else 'failed'})
        return response,collect(action)

    response,result = submit()
    if args.outcome in ('success','slow'):
        assert response.status_code == 200, response.text
        assert result['state'] == 'complete' and result['new_order_confirmed'], result
        if args.outcome == 'slow':
            assert result['payment_duration_ms'] >= 1000
        retry_response,retry = submit()
        assert retry_response.json()['id'] == response.json()['id']
        assert retry['state'] == 'complete' and retry['reused_order_confirmed']
        assert retry['payment_state'] == 'skipped' and retry['payment_duration_ms'] is None
        assert not any(e['service']=='minishop/payment-api' for e in retry['events'])
    else:
        assert response.status_code == (402 if args.outcome=='decline' else 503),response.text
        assert result['payment_state'] == ('declined' if args.outcome=='decline' else 'communication_failed')
        assert result['rollback_observed'] and not result['order_confirmed']
        assert client.get(base+'/api/orders/'+session).json() == []
        assert client.get(base+'/api/carts/'+session).json()['items']
    print(json.dumps({'environment':'isolated-local-compose','scenario':args.outcome,'state':result['state'],
                      'events':len(result['events']),'payment_ms':result['payment_duration_ms']}))
