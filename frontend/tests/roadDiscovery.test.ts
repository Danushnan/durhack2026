import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ClusterState, Edge } from '../src/k8s.ts'
import { carTrip, layoutCity, ROAD_W } from '../src/layout.ts'
import { buildStreetNetwork, ROUNDABOUT_RADIUS } from '../src/streetNetwork.ts'
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
  const initial = buildStreetNetwork(initialLayout, before.known)
  const updated = buildStreetNetwork(stableLayout, after.known, after.supplemental)
  assert.deepEqual(updated.segments.map(({ points }) => points), initial.segments.map(({ points }) => points))
  assert.deepEqual(updated.routes[roadKey(observedOnly)].outbound, initial.routes[roadKey(payment)].inbound)
})

test('new calls reuse connected streets and cars circulate in the same direction on return', () => {
  const deployments = sample.services.map((s) => ({ namespace: s.namespace, name: s.service.split('/')[1] }))
  const { known } = miniShopLayoutCalls([idle], sample.services.map((s) => s.service))
  const call = { from: 'minishop/minishop-web', to: 'minishop/redis' }
  const key = roadKey(call)
  assert.ok(!known.some((edge) => roadKey(edge) === key))
  const layout = layoutCity(deployments, ['node'], known)
  const before = buildStreetNetwork(layout, known)
  const after = buildStreetNetwork(layout, known, [call])
  assert.deepEqual(after.segments.map(({ points }) => points), before.segments.map(({ points }) => points))
  assert.ok(after.segments.filter(({ calls }) => calls.includes(key)).length > 1)

  const { outbound, inbound } = after.routes[key]
  const junctions = after.roundabouts.filter(({ calls }) => calls.includes(key))
  assert.ok(junctions.length > 0)
  for (const { center } of junctions) {
    for (const route of [outbound, inbound]) {
      const arc = carTrip(route, false).filter((point) => Math.abs(point.distanceTo(center) - (ROUNDABOUT_RADIUS + ROAD_W / 4)) < 0.002)
      assert.ok(arc.length > 3, 'the car follows the circular lane')
      for (let i = 1; i < arc.length; i++) {
        const a = arc[i - 1].clone().sub(center), b = arc[i].clone().sub(center)
        assert.ok(a.x * b.z - a.z * b.x < 0, 'outbound and return cars circulate in the same direction')
      }
    }
  }
})

test('cross-district calls reuse each district’s roundabouts and share one highway', () => {
  const { known } = miniShopLayoutCalls([idle], sample.services.map((s) => s.service))
  const otherDistrict = (key: string) => key.replace('minishop/', 'warehouse/')
  const shop = sample.services.map((s) => s.service)
  const keys = [...shop, ...shop.map(otherDistrict)]
  const deployments = keys.map((key) => {
    const [namespace, name] = key.split('/')
    return { namespace, name }
  })
  const local = [...known, ...known.map(({ from, to }) => ({ from: otherDistrict(from), to: otherDistrict(to) }))]
  const layout = layoutCity(deployments, [], local)
  const outbound = { from: 'minishop/minishop-web', to: 'warehouse/minishop-web' }
  const inbound = { from: outbound.to, to: outbound.from }
  const before = buildStreetNetwork(layout, local)
  const after = buildStreetNetwork(layout, local, [outbound, inbound])
  const key = roadKey(outbound), reverseKey = roadKey(inbound)
  const highways = after.segments.filter(({ highway }) => highway)
  assert.equal(highways.length, 1)
  assert.deepEqual(new Set(highways[0].calls), new Set([key, reverseKey]))
  assert.ok(highways[0].points.every(({ z }) => z === highways[0].points[0].z))
  const existingJunctions = after.roundabouts.filter(({ center, calls }) =>
    calls.includes(key) && before.roundabouts.some((junction) => junction.center.equals(center)))
  for (const district of layout.districts) {
    assert.ok(existingJunctions.some(({ center }) => center.x >= district.x0 && center.x <= district.x1),
      `approach should reuse ${district.name}'s roundabout`)
  }
  assert.deepEqual(after.routes[key].inbound, after.routes[reverseKey].outbound)
})

test('cross-district routes fall back to access roads in districts with no streets', () => {
  const call = { from: 'shop/web', to: 'data/redis' }
  const layout = layoutCity([{ namespace: 'shop', name: 'web' }, { namespace: 'data', name: 'redis' }], [], [call])
  const network = buildStreetNetwork(layout, [call])
  assert.ok(network.routes[roadKey(call)])
  assert.equal(network.segments.filter(({ highway }) => highway).length, 1)
  assert.equal(network.roundabouts.length, 2)
})

test('demo packet presets count vehicles separately from measured traffic and reset clears both queues', () => {
  const edge = { from: 'shop/web', to: 'data/redis', rps: 1, healthy: true }
  const initial = reduceWatchMessage(initialClusterState(), [source(null), { type: 'TRAFFIC', edges: [edge] }])
  const sent = reduceWatchMessage(initial, [
    { type: 'DEMO_PACKETS', count: 1, cross_district: false },
    { type: 'DEMO_PACKETS', count: 5, cross_district: true },
    { type: 'DEMO_PACKETS', count: 101, cross_district: true },
  ])
  assert.deepEqual(sent.demoPackets, { cars: 1, lorries: 5, reset: 0 })
  assert.deepEqual(sent.edges, [edge])
  const reset = reduceWatchMessage(sent, [{ type: 'DEMO_PACKETS_RESET' }])
  assert.deepEqual(reset.demoPackets, { cars: 0, lorries: 0, reset: 1 })
  assert.deepEqual(reset.edges, [edge])
})

test('simulator traffic remains visible without a Discovery mask', () => {
  const simulated = { from: 'shop/frontend', to: 'shop/cart', rps: 8, healthy: true }
  const cluster = reduceWatchMessage(initialClusterState(), [source(null), { type: 'TRAFFIC', edges: [simulated] }])
  assert.equal(cluster.context, null)
  assert.deepEqual(cluster.edges, [simulated])
  assert.equal(cluster.trafficSnapshotAt, undefined)
  assert.equal(roadVisible(simulated), true)
})
