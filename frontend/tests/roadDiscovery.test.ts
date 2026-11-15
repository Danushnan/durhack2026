import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClusterState, Edge } from '../src/k8s.ts'
import { buildRoads, layoutCity } from '../src/layout.ts'
import { miniShopLayoutCalls } from '../src/miniShopRoads.ts'
import { roadKey, roadVisible, startDiscovery, updateDiscovery } from '../src/roadDiscovery.ts'
import { initialClusterState, reduceWatchMessage } from '../src/watch.ts'
import { snapshot } from './liveMetrics.fixture.ts'

const sample = snapshot()
const serverStart = Date.parse(sample.observed_at)
const localStart = 1_000
const payment: Edge = { from: 'minishop/checkout-api', to: 'minishop/payment-api', requests: 1, rps: 0.2, healthy: true }
const cart: Edge = { ...payment, to: 'minishop/cart-api' }
const idle = { ...payment, requests: 0, rps: 0 }
const health = { type: 'HEALTH', stale: false, lastRefresh: serverStart }
const source = (context: string | null) => ({ type: 'SOURCE', context })

function tick(previous: ClusterState, offset: number, edges?: Edge[], prefix: unknown[] = []) {
  const metrics = { ...sample, observed_at: new Date(serverStart + offset).toISOString() }
  return reduceWatchMessage({ ...previous, connected: true }, [...prefix, health, ...(edges ? [{ type: 'TRAFFIC', edges }] : []), metrics],
    localStart + offset)
}

test('Discovery initially hides declared roads and only reveals measured directed relationships after arming', () => {
  let cluster = tick(initialClusterState(), 0, [payment, cart], [source(sample.context)])
  let discovery = startDiscovery(sample.source_id, localStart)
  assert.equal(roadVisible(payment), true)
  assert.equal(roadVisible(payment, discovery.roads), false)
  cluster = tick(cluster, 2_000, [payment])
  discovery = updateDiscovery(discovery, cluster)!
  assert.equal(discovery.armed, false)
  cluster = tick(cluster, 7_000, [payment])
  discovery = updateDiscovery(discovery, cluster)!
  assert.equal(discovery.armed, false)
  cluster = tick(cluster, 8_000, [payment, { ...cart, requests: 0 }])
  discovery = updateDiscovery(discovery, cluster)!
  assert.equal(discovery.armed, true)
  assert.deepEqual([...discovery.roads], [roadKey(payment)])
  assert.equal(roadVisible(payment, discovery.roads), true)
  assert.equal(roadVisible(cart, discovery.roads), false)
  assert.equal(roadVisible({ from: payment.to, to: payment.from }, discovery.roads), false)
  assert.equal(updateDiscovery(discovery, tick(cluster, 10_000, [{ ...payment, requests: 4 }])), discovery)
  assert.equal(updateDiscovery(discovery, tick(cluster, 12_000, [idle])), discovery)
})

test('reset discards visibility and ignores old windows, idle edges and unpaired or synthetic events', () => {
  const initial = tick(initialClusterState(), 0, [payment], [source(sample.context)])
  const first = tick(initial, 2_000, [payment])
  const armed = tick(first, 8_000, [payment])
  const previous = updateDiscovery(updateDiscovery(startDiscovery(sample.source_id, localStart), first), armed)!
  const reset = startDiscovery(sample.source_id, localStart + 8_000)
  assert.equal(previous.roads.size, 1)
  assert.equal(reset.roads.size, 0)
  assert.equal(updateDiscovery(reset, armed), reset)
  const anchoring = tick(armed, 10_000, [payment])
  const arming = updateDiscovery(reset, anchoring)!
  const heartbeat = tick(anchoring, 16_000, undefined, [{ type: 'DEMO_TRAFFIC', edges: [cart] }])
  const listening = updateDiscovery(arming, heartbeat)!
  assert.equal(listening.armed, true)
  assert.equal(listening.roads.size, 0)
  const zero = tick(heartbeat, 18_000, [idle, { ...cart, requests: undefined }])
  assert.equal(updateDiscovery(listening, zero), listening)
  const unpaired = reduceWatchMessage(zero, [{ type: 'TRAFFIC', edges: [cart] }], localStart + 19_000)
  assert.equal(updateDiscovery(listening, unpaired), listening)
  assert.deepEqual([...updateDiscovery(listening, tick(unpaired, 20_000, [cart]))!.roads], [roadKey(cart)])
})

test('same-source reconnect retains discoveries, ignores initial replay and resumes on fresh updates', () => {
  const initial = tick(initialClusterState(), 0, [idle], [source(sample.context)])
  const first = tick(initial, 2_000)
  const revealed = tick(first, 8_000, [payment])
  const discovery = updateDiscovery(updateDiscovery(startDiscovery(sample.source_id, localStart), first), revealed)!
  const disconnected = { ...revealed, connected: false }
  assert.equal(updateDiscovery(discovery, disconnected), discovery)
  const reconnect = { ...disconnected, connected: true, awaitingSnapshot: true }
  assert.equal(updateDiscovery(discovery, reconnect), discovery)
  const restored = tick(reconnect, 10_000, [payment, cart], [source(sample.context)])
  assert.equal(updateDiscovery(discovery, restored), discovery)
  assert.deepEqual([...updateDiscovery(discovery, tick(restored, 12_000, [cart]))!.roads], [roadKey(payment), roadKey(cart)])
  assert.equal(updateDiscovery(discovery, reduceWatchMessage(restored, [source('another-cluster')])), null)
  assert.equal(updateDiscovery(discovery, reduceWatchMessage(restored, [source(null)])), null)
})

test('stale, disconnected and partial snapshots cannot reveal roads', () => {
  const first = tick(initialClusterState(), 2_000, [idle], [source(sample.context)])
  const fresh = tick(first, 8_000, [payment])
  const arming = updateDiscovery(startDiscovery(sample.source_id, localStart), first)!
  const listening = { ...arming, armed: true }
  for (const invalid of [
    { ...fresh, connected: false },
    { ...fresh, stale: true },
    { ...fresh, metricsStale: true },
    { ...fresh, metricsError: 'Invalid snapshot' },
    { ...fresh, metrics: { ...fresh.metrics!, source: { ...sample.source, status: 'degraded' as const } } },
    { ...fresh, metrics: { ...fresh.metrics!, services: fresh.metrics!.services.map((s) => ({ ...s, window_complete: false })) } },
    { ...fresh, edges: [{ ...payment, to: 'other/payment-api' }] },
  ]) assert.equal(updateDiscovery(listening, invalid), listening)
  assert.deepEqual([...updateDiscovery(listening, fresh)!.roads], [roadKey(payment)])
})

test('a new observed-only relationship does not change MiniShop lots or declared road geometry', () => {
  const deployments = sample.services.map((s) => ({ namespace: s.namespace, name: s.service.split('/')[1] }))
  const workloadKeys = sample.services.map((s) => s.service)
  const observedOnly = { from: payment.to, to: payment.from }
  const before = miniShopLayoutCalls([idle], workloadKeys)
  const after = miniShopLayoutCalls([payment, observedOnly], workloadKeys)
  assert.equal(before.known.length, 10)
  assert.deepEqual(after.known, before.known)
  assert.deepEqual(after.supplemental, [observedOnly])
  const initialLayout = layoutCity(deployments, ['node'], before.known)
  const stableLayout = layoutCity(deployments, ['node'], after.known)
  assert.deepEqual(stableLayout, initialLayout)
  assert.deepEqual(buildRoads(stableLayout, after.known), buildRoads(initialLayout, before.known))
  assert.ok(buildRoads(stableLayout, after.supplemental)[roadKey(observedOnly)])
})

test('simulator traffic remains visible without a Discovery mask', () => {
  const simulated = { from: 'shop/frontend', to: 'shop/cart', rps: 8, healthy: true }
  const cluster = reduceWatchMessage(initialClusterState(), [source(null), { type: 'TRAFFIC', edges: [simulated] }])
  assert.equal(cluster.context, null)
  assert.deepEqual(cluster.edges, [simulated])
  assert.equal(cluster.trafficSnapshotAt, undefined)
  assert.equal(roadVisible(simulated), true)
})
