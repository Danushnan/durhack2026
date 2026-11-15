import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Vector3 } from 'three'
import { layoutCity, type Call } from '../src/layout.ts'
import { buildLiveRoads, streetKey } from '../src/liveRoads.ts'

const shops = ['cart-api', 'checkout-api', 'minishop-web', 'payment-api', 'postgres', 'product-api', 'redis']
const keys = shops.map(name => `minishop/${name}`)
const layout = layoutCity([
  { namespace: 'kube-system', name: 'coredns' },
  { namespace: 'local-path-storage', name: 'local-path-provisioner' },
  ...shops.map(name => ({ namespace: 'minishop', name })),
], ['control-plane', 'worker'], [], [], true)
const pairs = keys.flatMap(from => keys.filter(to => to !== from).map(to => ({ from, to })))

function shuffledBatch(seed: number): Call[] {
  const batch = pairs.slice()
  for (let i = batch.length - 1; i > 0; i--) {
    seed = (Math.imul(1664525, seed) + 1013904223) >>> 0
    const j = seed % (i + 1)
    const next = batch[j]
    batch[j] = batch[i]
    batch[i] = next
  }
  return Array.from({ length: 100 }, (_, i) => batch[i % batch.length])
}

function overlapping(a: Vector3, b: Vector3, c: Vector3, d: Vector3, axis: 'x' | 'z', side: 'x' | 'z') {
  return a[side] === b[side] && a[side] === c[side] && c[side] === d[side] &&
    Math.min(Math.max(a[axis], b[axis]), Math.max(c[axis], d[axis])) >
    Math.max(Math.min(a[axis], b[axis]), Math.min(c[axis], d[axis]))
}

test('batched calls reuse committed streets and never pave an occupied segment', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const batch = shuffledBatch(seed)
    const firstFive = buildLiveRoads(layout, batch.slice(0, 5))
    const full = buildLiveRoads(layout, batch)
    for (const [key, road] of Object.entries(firstFive.roads)) assert.deepEqual(full.roads[key], road)
    for (const { from, to } of batch) assert.ok(full.routes[streetKey(from, to)], `missing route ${from} → ${to}, seed ${seed}`)
    assert.ok(Object.keys(full.roads).length < keys.length * 2, `too many streets, seed ${seed}`)
    const segments = Object.values(full.roads).flatMap(road => road.slice(1).map((p, i) => [road[i], p]))
    for (const [i, [a, b]] of segments.entries()) {
      for (const [c, d] of segments.slice(0, i)) {
        assert.ok(!overlapping(a, b, c, d, 'x', 'z') && !overlapping(a, b, c, d, 'z', 'x'), `overlapping pavement, seed ${seed}`)
      }
    }
  }
})
