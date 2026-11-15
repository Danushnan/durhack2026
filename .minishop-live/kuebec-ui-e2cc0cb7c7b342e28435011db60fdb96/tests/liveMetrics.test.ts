import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { isLiveMetrics, liveServiceView, LIVE_COLOR, numberText, rateText, summarizeLive } from '../src/liveMetrics.ts'
import { checkSnapshotFreshness, initialClusterState, reduceWatchMessage } from '../src/watch.ts'
import { paymentDeployment, snapshot } from './liveMetrics.fixture.ts'

const receive = (metrics = snapshot()) => reduceWatchMessage({ ...initialClusterState(), connected: true, awaitingSnapshot: true }, [
  { type: 'SOURCE', context: 'kind-minishop', mode: 'live' }, { type: 'ADDED', object: paymentDeployment }, metrics,
], 1000)

test('complete SERVICE_METRICS fixture matches every schema field and is kept outside resources', () => {
  const schema = JSON.parse(readFileSync(new URL('../../backend/service_metrics.schema.json', import.meta.url), 'utf8'))
  const event = snapshot()
  assert.deepEqual(Object.keys(event).sort(), schema.required.sort())
  assert.deepEqual(Object.keys(event.services[0]).sort(), schema.properties.services.items.required.sort())
  assert.deepEqual(Object.keys(event.source).sort(), schema.properties.source.required.sort())
  assert.deepEqual(Object.keys(event.window).sort(), schema.properties.window.required.sort())
  assert.deepEqual(Object.keys(event.services[3].checkout!).sort(), schema.properties.services.items.properties.checkout.anyOf[0].required.sort())
  assert.ok(isLiveMetrics(event))
  const state = receive(event)
  assert.equal(state.metrics, event)
  assert.deepEqual(Object.keys(state.objects), ['payment-deployment'])
  const replacement = snapshot({ request_count: 2, requests_per_second: 0.2 })
  assert.equal(reduceWatchMessage(state, [replacement]).metrics?.services[4].request_count, 2)
  assert.equal(reduceWatchMessage(state, [event, event]).metrics?.services[4].request_count, 4)
  assert.equal(reduceWatchMessage(state, [replacement]).objects, state.objects)
})

test('malformed and future events cannot crash or corrupt resource updates', () => {
  const state = receive()
  for (const data of ['{', '{}', [{ type: 'FUTURE' }], [null], [{ type: 'MODIFIED' }]]) {
    assert.doesNotThrow(() => reduceWatchMessage(state, data))
    assert.equal(reduceWatchMessage(state, data).metrics, state.metrics)
  }
  for (const change of [{ p95_latency_ms: -1 }, { error_rate: 2 }, { request_count: '4' }, { window_complete: null }]) {
    const invalid = snapshot(change as never)
    assert.equal(isLiveMetrics(invalid), false)
    const next = reduceWatchMessage(state, [invalid, { type: 'DELETED', object: paymentDeployment }])
    assert.equal(next.metrics, state.metrics)
    assert.equal(Object.keys(next.objects).length, 0)
    assert.ok(next.metricsError)
  }
  const duplicate = snapshot(); duplicate.services[0] = duplicate.services[1]
  assert.equal(isLiveMetrics(duplicate), false)
  const missing = snapshot(); delete (missing.services[0] as Partial<typeof missing.services[0]>).checkout
  assert.equal(isLiveMetrics(missing), false)
  for (const mutate of [
    (s: any) => { s.schema_version = 2 }, (s: any) => { s.source.status = 'invented' },
    (s: any) => { s.window.seconds = 0 }, (s: any) => { s.services[3].checkout.success_rate = 2 },
    (s: any) => { s.services[4].avg_latency_ms = Infinity }, (s: any) => { s.observed_at = 'not a timestamp' },
  ]) {
    const invalid = snapshot(); mutate(invalid); assert.equal(isLiveMetrics(invalid), false)
  }
})

test('Payments visual classification follows the backend, independently of ready pods and edge errors', () => {
  const slow = receive(snapshot({ application_status: 'degraded', p95_latency_ms: 2200 }))
  const view = liveServiceView(paymentDeployment, slow)!
  assert.equal(view.application, 'degraded'); assert.equal(view.color, LIVE_COLOR.degraded)
  assert.equal(view.infrastructure, 'healthy'); assert.equal(view.metrics?.ready_replicas, 3)
  assert.equal(paymentDeployment.status.readyReplicas, 3)
  const recovered = reduceWatchMessage(slow, [snapshot()])
  assert.equal(liveServiceView(paymentDeployment, recovered)?.color, LIVE_COLOR.healthy)
  const decline = receive(snapshot({ business_rejection_count: 4, business_decline_count: 4 }))
  assert.equal(liveServiceView(paymentDeployment, decline)?.application, 'healthy')
  const errors = receive(snapshot({ application_status: 'degraded', error_count: 2, error_rate: 0.5 }))
  assert.equal(liveServiceView(paymentDeployment, errors)?.application, 'degraded')
  // A backend can use configured thresholds; the frontend must never classify by its own thresholds.
  assert.equal(liveServiceView(paymentDeployment, receive(snapshot({ p95_latency_ms: 2200 })))?.application, 'healthy')
})

test('service identity survives pod replacement and guards Deployment and namespace collisions', () => {
  const state = receive()
  const pod = { kind: 'Pod', metadata: { uid: 'new-pod', name: 'payment-api-new', namespace: 'minishop' }, deploymentUid: 'payment-deployment' }
  assert.equal(liveServiceView(paymentDeployment, reduceWatchMessage(state, [{ type: 'ADDED', object: pod }]))?.metrics?.service, 'minishop/payment-api')
  assert.equal(liveServiceView({ ...paymentDeployment, metadata: { ...paymentDeployment.metadata, uid: 'replacement' } }, state)?.metrics, undefined)
  assert.equal(liveServiceView({ ...paymentDeployment, metadata: { ...paymentDeployment.metadata, namespace: 'other' } }, state)?.metrics, undefined)
})

test('reconnect replaces inventory atomically, keeps matching metrics and accepts the restarted source snapshot', () => {
  const previous = receive()
  const reconnecting = { ...previous, connected: true, awaitingSnapshot: true }
  assert.equal(reconnecting.objects, previous.objects)
  const next = reduceWatchMessage(reconnecting, [{ type: 'SOURCE', context: 'kind-minishop' }, snapshot()])
  assert.deepEqual(next.objects, {})
  assert.ok(next.metrics)
  assert.equal(next.awaitingSnapshot, false)
  const simulator = reduceWatchMessage(next, [{ type: 'SOURCE', context: null }, { type: 'TRAFFIC', edges: [] }])
  assert.equal(simulator.metrics, undefined); assert.equal(simulator.context, null)
  assert.equal(liveServiceView(paymentDeployment, simulator), undefined)
})

test('TRAFFIC and HEALTH preserve real edge fields and independent resource freshness', () => {
  const edge = { from: 'minishop/checkout-api', to: 'minishop/payment-api', rps: 0.5, healthy: true, error_rate: 1, refused_rate: 0, latency_ms: 100 }
  const next = reduceWatchMessage(receive(), [{ type: 'TRAFFIC', edges: [edge] }, { type: 'HEALTH', stale: true, lastRefresh: 123 }])
  assert.equal(next.edges[0], edge); assert.equal(next.lastRefresh, 123)
  assert.equal(liveServiceView(paymentDeployment, next)?.infrastructure, 'unknown')
  assert.equal(liveServiceView(paymentDeployment, next)?.application, 'healthy')
})

test('idle, partial, missing, stale and disconnected data never become healthy observations', () => {
  const idle = receive(snapshot({ request_count: 0, requests_per_second: 0, avg_latency_ms: null, p95_latency_ms: null,
    error_count: 0, error_rate: null, availability: 'idle', application_status: 'unknown' }))
  const idleView = liveServiceView(paymentDeployment, idle)!
  assert.equal(idleView.application, 'unknown'); assert.equal(idleView.availability, 'idle')
  assert.equal(numberText(idleView.metrics?.request_count), '0'); assert.equal(rateText(idleView.metrics?.error_rate), '—')
  const partial = receive(snapshot({ window_complete: false, availability: 'partial', application_status: 'unknown' }))
  assert.equal(liveServiceView(paymentDeployment, partial)?.application, 'unknown')
  // Defensive against internally inconsistent but structurally valid input.
  assert.equal(liveServiceView(paymentDeployment, receive(snapshot({ availability: 'idle' })))?.application, 'unknown')
  const stale = checkSnapshotFreshness(receive(), 11_001)
  assert.equal(stale.metricsStale, true)
  assert.equal(liveServiceView(paymentDeployment, stale)?.application, 'unknown')
  assert.equal(liveServiceView(paymentDeployment, stale)?.availability, 'stale')
  const disconnected = { ...receive(), connected: false }
  assert.equal(liveServiceView(paymentDeployment, disconnected)?.availability, 'disconnected')
  assert.equal(liveServiceView(paymentDeployment, disconnected)?.metrics?.request_count, 4)
  assert.equal(liveServiceView(paymentDeployment, disconnected)?.infrastructure, 'unknown')
  assert.equal(liveServiceView(paymentDeployment, reduceWatchMessage(stale, [snapshot()], 12_000))?.application, 'healthy')
})

test('data stores retain infrastructure health without fabricated HTTP measurements', () => {
  const state = receive()
  const postgres = { ...paymentDeployment, metadata: { name: 'postgres', namespace: 'minishop', uid: 'postgres-deployment' } }
  const view = liveServiceView(postgres, state)!
  assert.equal(view.application, 'not_applicable'); assert.equal(view.infrastructure, 'healthy')
  assert.equal(view.availability, 'unsupported'); assert.equal(view.metrics?.requests_per_second, null)
})

test('overview counts service completions, weights averages, and never averages p95s', () => {
  const metrics = snapshot({ request_count: 8, requests_per_second: 0.8, avg_latency_ms: 200, p95_latency_ms: 250, error_count: 2, error_rate: 0.25 })
  const summary = summarizeLive(metrics)
  assert.equal(summary.requests, 24); assert.equal(summary.errors, 2)
  assert.ok(Math.abs(summary.average! - 3200 / 24) < 1e-9); assert.equal(summary.highestP95, 250)
  assert.equal(summary.errorRate, 2 / 24); assert.equal(summary.coverage, 5)
  const unavailable = snapshot()
  unavailable.services = unavailable.services.map((r) => ({ ...r, request_count: null, requests_per_second: null,
    avg_latency_ms: null, p95_latency_ms: null, error_count: null, error_rate: null, window_complete: false }))
  assert.equal(summarizeLive(unavailable).requests, null)
  assert.equal(summarizeLive(unavailable).errorRate, null)
  assert.equal(summarizeLive(unavailable).highestP95, null)
})

test('out-of-order snapshots, source changes and reconnects do not mix counters or identities', () => {
  const state = receive()
  const old = snapshot({ request_count: 999 })
  old.observed_at = '2026-11-14T20:59:59Z'
  assert.equal(reduceWatchMessage(state, [old]).metrics, state.metrics)
  assert.equal(reduceWatchMessage({ ...state, awaitingSnapshot: true }, [{ type: 'SOURCE', context: 'kind-minishop' }, old]).metrics, old)
  const other = snapshot()
  other.context = 'other-context'; other.source_id = 'kubernetes:other-context:minishop'
  const changed = reduceWatchMessage(state, [{ type: 'SOURCE', context: 'other-context' }, other])
  assert.equal(changed.metrics, other); assert.deepEqual(changed.objects, {})
  const mismatched = reduceWatchMessage(state, [other])
  assert.equal(mismatched.metrics, state.metrics); assert.ok(mismatched.metricsError)
})
