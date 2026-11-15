from dataclasses import replace
from uuid import uuid4

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from journeys import Action, COLLECTION, JourneyStore, TTL
from live_telemetry import LiveTelemetry, Observation

NOW = 1_800_000_000
SESSION = str(uuid4())


def action(**changes):
    return Action(action_id=uuid4(), mutation_id=uuid4(), refresh_id=uuid4(), **changes)


def event(rid, service, kind, *, target=None, method=None, route=None, operation=None, status=200, source=None):
    return Observation(str(uuid4()), 'minishop', NOW + 1, 'minishop/' + service, kind,
                       'pod-uid', 'pod', 'workload', None, str(rid),
                       'minishop/' + source if source else ('minishop/' + service if kind in ('dependency','http_client') else None), 'minishop/' + target if target else None,
                       method, route, operation, status, 12.5, None, 'completed' if kind == 'dependency' else None)


def evidence(a, mutation=200, refresh=200):
    route = f'/carts/{SESSION}'
    return [
        event(a.mutation_id, 'cart-api', 'http_server', method='POST', route=route+'/items', source='minishop-web', status=mutation),
        event(a.mutation_id, 'cart-api', 'http_client', target='product-api', method='GET', route='/products/' + str(uuid4())),
        event(a.mutation_id, 'product-api', 'dependency', target='postgres', operation='products.select_one'),
        event(a.mutation_id, 'cart-api', 'dependency', target='redis', operation='basket.mutate'),
        event(a.refresh_id, 'cart-api', 'http_server', method='GET', route=route, source='minishop-web', status=refresh),
        event(a.refresh_id, 'cart-api', 'dependency', target='redis', operation='basket.get'),
        event(a.refresh_id, 'cart-api', 'http_client', target='product-api', method='GET', route='/products'),
    ]


def setup(a=None):
    a = a or action(mutation='succeeded', refresh='succeeded')
    telemetry = LiveTelemetry('kind-minishop')
    store = JourneyStore()
    viewer = str(uuid4())
    store.register(viewer, a, telemetry, NOW)
    return a, telemetry, store, viewer


def read(store, viewer, a, telemetry, now=NOW+2):
    return store.read(viewer, str(a.action_id), telemetry, now)


def test_two_distinct_requests_genuine_dependencies_no_cross_database_edge():
    a, t, s, v = setup()
    rows = evidence(a)
    t.ingest(rows, NOW+2)
    result = read(s, v, a, t)
    assert result['state'] == 'complete'
    assert result['mutation_accepted']
    assert {e['request_id'] for e in result['events']} == {str(a.mutation_id), str(a.refresh_id)}
    links = {(step['from_service'], step['to_service']) for step in result['steps']}
    assert ('minishop/product-api', 'minishop/postgres') in links
    assert ('minishop/cart-api', 'minishop/redis') in links
    assert ('minishop/postgres', 'minishop/redis') not in links
    assert SESSION not in str(result)
    assert {e['event_id'] for e in result['events']} == {r.event_id for r in rows}


@pytest.mark.parametrize('mutation,refresh,browser_mutation,browser_refresh', [
    (409,200,'failed','not_sent'), (200,503,'succeeded','failed')])
def test_rejection_and_refresh_failure_are_separate(mutation, refresh, browser_mutation, browser_refresh):
    a,t,s,v = setup(action(mutation=browser_mutation,refresh=browser_refresh))
    t.ingest(evidence(a,mutation,refresh),NOW+2)
    result=read(s,v,a,t)
    assert result['state']=='failed'
    assert result['mutation_accepted'] == (mutation==200)
    # basket.mutate records completed even when the root rejects the business operation.
    assert result['steps'][3]['state']=='observed'
    assert result['steps'][4]['state']==('observed' if mutation==200 else 'failed')


def test_wrapper_without_root_does_not_prove_mutation():
    a,t,s,v=setup()
    t.ingest([evidence(a)[3]],NOW+2)
    result=read(s,v,a,t)
    assert not result['mutation_accepted']
    assert result['state']=='pending'
    assert result['steps'][4]['description']=='Observation unavailable for this stage.'


def test_late_events_dedup_final_poll_and_retention():
    a,t,s,v=setup()
    assert read(s,v,a,t)['state']=='pending'
    rows=evidence(a)
    t.ingest(rows+rows,NOW+4)
    assert len(read(s,v,a,t, NOW+COLLECTION+1)['events'])==len(rows)
    t.ingest([replace(rows[0],event_id='too-late')],NOW+COLLECTION+2)
    assert len(read(s,v,a,t,NOW+COLLECTION+3)['events'])==len(rows)
    with pytest.raises(HTTPException) as expired:
        read(s,v,a,t,NOW+TTL+1)
    assert expired.value.status_code==404


def test_missing_events_are_partial_after_collection():
    a,t,s,v=setup()
    result=read(s,v,a,t,NOW+COLLECTION+1)
    assert result['state']=='partial'
    assert result['steps'][0]['state']=='unavailable'


@pytest.mark.parametrize('kind',['duplicate','wrong-route','wrong-basket'])
def test_ambiguous_roots_suppress_guide(kind):
    a,t,s,v=setup()
    rows=evidence(a)
    if kind=='duplicate': rows.append(replace(rows[0],event_id='second-root'))
    if kind=='wrong-route': rows.append(replace(rows[0],event_id='other-route',route='/carts/other'))
    if kind=='wrong-basket': rows[4]=replace(rows[4],route='/carts/other')
    t.ingest(rows,NOW+2)
    result=read(s,v,a,t)
    assert result['state']=='ambiguous'
    assert not result['mutation_accepted']
    assert not any(step['from_service'] for step in result['steps'])


def test_viewers_sequential_actions_and_background_are_isolated():
    a,t,s,v=setup()
    b=action(mutation='succeeded',refresh='succeeded')
    v2=str(uuid4())
    s.register(v2,b,t,NOW)
    t.ingest(evidence(a)+evidence(b)+[event(uuid4(),'payment-api','http_server',route='/payments',method='POST')],NOW+2)
    assert len(read(s,v,a,t)['events'])==7
    assert len(read(s,v2,b,t)['events'])==7
    with pytest.raises(HTTPException): read(s,v2,a,t)
    c=action()
    s.register(v,c,t,NOW+3)
    assert not read(s,v,c,t,NOW+4)['events']
    assert len(read(s,v,a,t,NOW+4)['events'])==7


def test_reusing_request_ids_or_action_ids_is_rejected():
    a,t,s,v=setup()
    with pytest.raises(HTTPException) as conflict:
        s.register(str(uuid4()),a,t,NOW)
    assert conflict.value.status_code==409
    with pytest.raises(HTTPException):
        s.register(v,a.model_copy(update={'refresh_id':uuid4()}),t,NOW)
    with pytest.raises(HTTPException):
        s.register(v,action().model_copy(update={'mutation_id':a.refresh_id,'refresh_id':a.refresh_id}),t,NOW)


def test_same_collector_reconnect_retains_and_source_switch_rejects():
    a,t,s,v=setup()
    t.ingest(evidence(a),NOW+2)
    assert read(s,v,a,t)['state']=='complete'
    # Same context, new collector process/session must not reuse old evidence.
    with pytest.raises(HTTPException) as changed:
        read(s,v,a,LiveTelemetry(t.context))
    assert changed.value.status_code==409
    with pytest.raises(HTTPException): read(s,v,a,LiveTelemetry('different'))


def test_other_app_and_namespace_not_used():
    a,t,s,v=setup()
    rows=evidence(a)
    t.ingest([replace(r,application='other') for r in rows]+[replace(r,event_id='else'+r.event_id,service='other/'+r.service.split('/')[1]) for r in rows],NOW+2)
    result=read(s,v,a,t)
    assert not result['mutation_accepted']
    assert not any(step['event_ids'] for step in result['steps'])


def test_bounds_and_final_browser_outcomes():
    a,t,s,v=setup()
    with pytest.raises(HTTPException): s.register(v,a.model_copy(update={'mutation':'pending'}),t,NOW+1)
    rows=[event(a.mutation_id,'cart-api','dependency',target='redis',operation='basket.get') for _ in range(200)]
    t.ingest(rows,NOW+2)
    result=read(s,v,a,t)
    assert result['truncated'] and len(result['events'])==128
    for _ in range(19): s.register(v,action(),t,NOW)
    with pytest.raises(HTTPException) as cap: s.register(v,action(),t,NOW)
    assert cap.value.status_code==429


def test_routes_disabled_auth_simulator_and_live(monkeypatch):
    import main
    from types import SimpleNamespace
    client=TestClient(main.app)
    monkeypatch.delenv('KUBEVERSE_JOURNEYS',raising=False)
    assert client.get('/api/journeys/'+str(uuid4())).status_code==403
    monkeypatch.setenv('KUBEVERSE_JOURNEYS','1')
    assert client.get('/api/journeys/'+str(uuid4())).status_code==401
    monkeypatch.setattr(main,'live',None)
    headers={'Authorization':'Bearer '+str(uuid4())}
    a=action()
    assert client.post('/api/journeys/actions',json=a.model_dump(mode='json'),headers=headers).status_code==409
    monkeypatch.setattr(main,'live',SimpleNamespace(telemetry=LiveTelemetry('test')))
    result=client.post('/api/journeys/actions',json=a.model_dump(mode='json'),headers=headers)
    assert result.status_code==200
    assert client.get('/api/journeys/'+str(a.action_id),headers=headers).status_code==200


def test_each_basket_stage_explains_what_why_and_importance_without_inventing_missing_facts():
    a,t,s,v=setup()
    t.ingest(evidence(a),NOW+2)
    for step in read(s,v,a,t)['steps']:
        assert all(step[field] for field in ('heading','what','why','matters','evidence_label'))
    a2,t2,s2,v2=setup()
    result=read(s2,v2,a2,t2,NOW+COLLECTION+1)
    assert all(step['what']=='Observation unavailable for this stage.' and step['evidence_label']=='Partial'
               for step in result['steps'][:-1])
