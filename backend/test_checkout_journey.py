from dataclasses import replace
from uuid import uuid4
import pytest
from fastapi import HTTPException
from pydantic import ValidationError
from journeys import Action
from test_journeys import NOW, SESSION, event, setup, read


def checkout_action(**updates):
    return Action(kind='checkout',action_id=uuid4(),request_id=uuid4(),checkout='succeeded',**updates)


def checkout_events(action, *, status=200, payment_status=200, reused=False, latency=1500):
    rid=action.request_id
    def call(service,target,method,route,code=200):
        return event(rid,service,'http_client',target=target,method=method,route=route,status=code)
    def op(service,target,operation):
        return event(rid,service,'dependency',target=target,operation=operation)
    root=event(rid,'checkout-api','http_server',source='minishop-web',method='POST',route=f'/checkout/{SESSION}',status=status)
    tx=op('checkout-api','postgres','orders.transaction')
    if status>=400: tx=replace(tx,outcome='rolled_back')
    finish=[call('checkout-api','cart-api','POST',f'/internal/carts/{SESSION}/finish'),op('cart-api','redis','basket.finish')]
    if reused: return [root,tx,op('checkout-api','postgres','orders.reuse'),*finish]
    return [root,call('checkout-api','cart-api','POST',f'/internal/carts/{SESSION}/snapshot'),op('cart-api','redis','basket.freeze'),
            call('checkout-api','product-api','GET','/products'),op('product-api','postgres','products.select'),
            replace(call('checkout-api','payment-api','POST','/payments',payment_status),latency_ms=latency),tx,
            *([op('checkout-api','postgres','orders.persist')] if status==200 else []),*finish]


def test_checkout_success_structured_education_and_true_road_links():
    a,t,s,v=setup(checkout_action(basket_cleared=True))
    t.ingest(checkout_events(a),NOW+2)
    result=read(s,v,a,t)
    assert result['kind']=='checkout' and result['state']=='complete'
    assert result['requests']=={'checkout':str(a.request_id)}
    assert result['new_order_confirmed'] and result['order_confirmed'] and not result['reused_order_confirmed']
    assert result['payment_duration_ms']==1500
    assert all(all(step[field] for field in ('heading','what','why','matters','evidence_label')) for step in result['steps'])
    links={(step['from_service'],step['to_service']) for step in result['steps']}
    assert ('minishop/postgres','minishop/redis') not in links
    assert ('minishop/cart-api','minishop/redis') in links
    assert result['steps'][3]['basis']=='inferred'
    assert 'not a measurement of SQL execution alone' in result['steps'][5]['what']
    assert 'does not reveal whether' in result['steps'][7]['what']


def test_declined_payment_rollback_is_not_database_infrastructure_failure():
    a,t,s,v=setup(checkout_action().model_copy(update={'checkout':'failed'}))
    t.ingest(checkout_events(a,status=402,payment_status=402),NOW+2)
    result=read(s,v,a,t)
    assert result['state']=='failed' and result['payment_state']=='declined'
    assert result['rollback_observed'] and not result['new_order_confirmed']
    assert 'HTTP 402' in result['steps'][4]['what']
    assert 'not evidence that PostgreSQL infrastructure failed' in result['steps'][5]['what']
    assert result['steps'][7]['basis']=='inferred'
    assert 'contents are not observed' in result['steps'][7]['what']


def test_payment_slowdown_uses_only_selected_outgoing_call_duration():
    a,t,s,v=setup(checkout_action())
    rows=checkout_events(a,latency=2345.67)
    rows.append(replace(event(a.request_id,'payment-api','http_server',source='checkout-api',method='POST',route='/payments'),latency_ms=2300))
    rows=[replace(row,latency_ms=5000) if row.operation=='orders.transaction' else row for row in rows]
    t.ingest(rows,NOW+2)
    result=read(s,v,a,t)
    assert result['payment_duration_ms']==2345.67
    assert '2345.67 ms' in result['steps'][4]['what']
    assert 'Healthy pods do not guarantee' in result['steps'][4]['what']


def test_idempotent_retry_requires_positive_reuse_evidence_before_skipping():
    a,t,s,v=setup(checkout_action())
    rows=checkout_events(a,reused=True)
    t.ingest(rows,NOW+2)
    result=read(s,v,a,t)
    assert result['state']=='complete' and result['reused_order_confirmed']
    assert not result['new_order_confirmed'] and result['payment_state']=='skipped'
    assert result['payment_duration_ms'] is None
    for i in (1,2,3,4):
        assert result['steps'][i]['state']=='skipped'
        assert result['steps'][i]['basis']=='inferred'
        assert result['steps'][i]['from_service'] is None and result['steps'][i]['to_service'] is None
    a2,t2,s2,v2=setup(checkout_action())
    t2.ingest([r for r in checkout_events(a2,reused=True) if r.operation!='orders.reuse'],NOW+2)
    missing=read(s2,v2,a2,t2,NOW+61)
    assert missing['state']=='partial' and missing['order_confirmed']
    assert missing['steps'][4]['state']=='unavailable' and not missing['reused_order_confirmed']


@pytest.mark.parametrize('error,state,phrase',[('ConnectError','communication_failed','does not establish a Payment HTTP response'),('HTTP 503','http_failure','answered with HTTP 503')])
def test_failed_communication_vs_actual_http_failure(error,state,phrase):
    a,t,s,v=setup(checkout_action().model_copy(update={'checkout':'failed'}))
    rows=[replace(r,error=error) if r.target=='minishop/payment-api' else r for r in checkout_events(a,status=503,payment_status=503)]
    t.ingest(rows,NOW+2)
    result=read(s,v,a,t)
    assert result['payment_state']==state and phrase in result['steps'][4]['what']
    assert not result['order_confirmed']


def test_checkout_keeps_collecting_longer_than_basket_for_slow_requests():
    a,t,s,v=setup(checkout_action())
    assert read(s,v,a,t,NOW+31)['collecting']
    rows=[replace(row,observed_at=NOW+45) for row in checkout_events(a)]
    t.ingest(rows,NOW+47)
    result=read(s,v,a,t,NOW+48)
    assert result['state']=='complete' and result['collection_seconds']==60


@pytest.mark.parametrize('change',['root','reuse-and-payment','wrong-basket','duplicate-payment'])
def test_ambiguous_checkout_never_claims_outcome_or_draws_relationship(change):
    a,t,s,v=setup(checkout_action())
    rows=checkout_events(a)
    if change=='root': rows.append(replace(rows[0],event_id='other-root'))
    if change=='reuse-and-payment': rows.append(event(a.request_id,'checkout-api','dependency',target='postgres',operation='orders.reuse'))
    if change=='wrong-basket': rows[1]=replace(rows[1],route=f'/internal/carts/{uuid4()}/snapshot')
    if change=='duplicate-payment': rows.append(replace(rows[5],event_id='other-payment'))
    t.ingest(rows,NOW+2)
    result=read(s,v,a,t)
    assert result['state']=='ambiguous' and not result['order_confirmed']
    assert result['payment_duration_ms'] is None
    assert not any(step['from_service'] for step in result['steps'])


def test_checkout_and_basket_ids_cannot_be_reassigned_across_viewers_or_kinds():
    a,t,s,v=setup(checkout_action())
    with pytest.raises(HTTPException): s.register(str(uuid4()),a,t,NOW)
    with pytest.raises(HTTPException): s.register(v,a.model_copy(update={'request_id':uuid4()}),t,NOW)
    with pytest.raises(HTTPException): s.register(v,a.model_copy(update={'checkout':'pending'}),t,NOW)
    with pytest.raises(ValidationError): Action(kind='checkout',action_id=uuid4(),request_id=uuid4(),mutation_id=uuid4())
    with pytest.raises(ValidationError): Action(kind='add_to_basket',action_id=uuid4(),request_id=uuid4())


def test_concurrent_checkouts_and_unrelated_background_are_isolated():
    a,t,s,v=setup(checkout_action())
    b=checkout_action(); v2=str(uuid4());s.register(v2,b,t,NOW)
    t.ingest(checkout_events(a)+checkout_events(b)+checkout_events(checkout_action()),NOW+2)
    first,second=read(s,v,a,t),read(s,v2,b,t)
    assert first['state']==second['state']=='complete'
    assert {e['request_id'] for e in first['events']}=={str(a.request_id)}
    assert {e['request_id'] for e in second['events']}=={str(b.request_id)}


def test_cleanup_failure_does_not_erase_confirmed_order_or_invent_basket_clear():
    a,t,s,v=setup(checkout_action(basket_cleared=False))
    rows=[replace(row,status=503,error='ConnectError') if row.route and row.route.endswith('/finish') else row
          for row in checkout_events(a)]
    t.ingest(rows,NOW+2)
    result=read(s,v,a,t)
    assert result['new_order_confirmed'] and result['order_confirmed']
    assert result['cleanup_failed'] and result['state']=='partial'
    assert 'cleanup failure does not undo that order' in result['steps'][6]['what']
    assert result['browser']['basket_cleared'] is False
