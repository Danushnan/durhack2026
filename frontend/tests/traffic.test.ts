import assert from 'node:assert/strict'
import { test } from 'node:test'
import { admit, bendLimit, type CarAgent, DRIVE, exitClear, newCar, stepCars, type Trip } from '../src/traffic.ts'

const straight = (len: number): Trip => ({ okLength: len, backLength: 2 * len, door: len - 2, limitOk: () => 99, limitBack: () => 99 })

/** Spawn a Car every `every` seconds for `seconds`, stepping at 60 fps. */
function simulate(trip: Trip, healthy: boolean, errors: boolean, seconds: number, every = 0.4) {
  let cars: CarAgent[] = [], served = 0, minGap = Infinity, next = 0, slot = 0
  for (let t = 0; t < seconds; t += 1 / 60) {
    if (t >= next && exitClear(cars)) { cars.push(newCar(slot++, () => 0.5)); next = t + every }
    const r = stepCars(cars, 1 / 60, t, trip, { refused: healthy ? 0 : 1, error: errors ? 1 : 0 })
    cars = r.cars; served += r.served.length
    for (const lane of [cars.filter((c) => c.phase !== 'back'), cars.filter((c) => c.phase === 'back')]) {
      const s = lane.map((c) => c.s).sort((a, b) => a - b)
      for (let i = 1; i < s.length; i++) minGap = Math.min(minGap, s[i] - s[i - 1])
    }
  }
  return { cars, served, minGap }
}

test('healthy traffic is served and Cars never overlap', () => {
  const r = simulate(straight(40), true, false, 30)
  assert.ok(r.served > 20, `served ${r.served}`)
  assert.ok(r.minGap >= DRIVE.length * 0.9, `gap ${r.minGap}`)
})

test('an Impacted service makes Cars queue at its door, then return with an error', () => {
  const r = simulate(straight(40), true, true, 12, 0.3)
  assert.equal(r.served, 0)
  const queued = r.cars.filter((c) => c.phase !== 'back' && c.v < 2 && c.s > 20)
  assert.ok(queued.length >= 3, `queue of ${queued.length}`)
  assert.ok(r.cars.some((c) => c.phase === 'back' && c.fate === 'error'))
  assert.ok(r.minGap >= DRIVE.length * 0.9, `gap ${r.minGap}`)
})

test('refused Cars turn back at the door', () => {
  const r = simulate(straight(40), false, false, 15)
  assert.equal(r.served, 0)
  assert.ok(r.cars.every((c) => c.phase === 'out' || c.fate === 'refused'))
})

test('Cars slow down for bends', () => {
  // A quarter circle of radius 2, then a straight: grip 10 allows sqrt(10 * 2) ≈ 4.5 in the bend.
  const arc = Array.from({ length: 9 }, (_, i) => ({ x: 2 * Math.sin((i / 8) * Math.PI / 2), z: 2 - 2 * Math.cos((i / 8) * Math.PI / 2) }))
  const limit = bendLimit([...arc, { x: 2, z: 12 }], 10)
  assert.ok(Math.abs(limit(1.5) - Math.sqrt(20)) < 0.5, `bend ${limit(1.5)}`)
  assert.equal(bendLimit([{ x: 0, z: 0 }, { x: 5, z: 0 }, { x: 10, z: 0 }])(5), 99)
})

test('Scenery height cap: tall behind a kept area, low in front of it, nothing inside', async () => {
  const { heightCap } = await import('../src/layout.ts')
  const keep = [{ x0: 0, x1: 10, z0: 0, z1: 10 }]
  assert.equal(heightCap(keep, 5, 5), 0)                 // inside
  assert.equal(heightCap(keep, 14, 14), 4)               // in front (camera side): it would hide the corner past 4
  assert.equal(heightCap(keep, -5, 5), Infinity)         // behind: hides nothing
  assert.equal(heightCap(keep, 30, 5), Infinity)         // off to the side of the view line
})

test('rush hour puts clearly more Cars on a Road, up to what the exit lets out', () => {
  const leaving = (rps: number) => {
    let cars: CarAgent[] = [], credit = 0, n = 0
    for (let t = 0; t < 60; t += 1 / 60) {
      const a = admit(credit, rps, 1 / 60, cars, () => 0.5)
      credit = a.credit
      if (a.leave) cars.push(newCar(n++, () => 0.5))
      cars = stepCars(cars, 1 / 60, t, straight(40), { refused: 0, error: 0 }).cars
    }
    return n / 60
  }
  const normal = leaving(8), rush = leaving(24)
  assert.ok(rush > 1.4 * normal, `normal ${normal}/s, rush ${rush}/s`)
  assert.ok(leaving(2) > 0.1, 'a quiet Road still sees Cars')
})

test('the demo city: no Road runs through another Building', async () => {
  const { buildRoads, checkRoads, layoutCity } = await import('../src/layout.ts')
  const deps = ['shop/frontend', 'shop/cart', 'shop/checkout', 'shop/payments', 'data/postgres', 'data/redis']
    .map((k) => ({ namespace: k.split('/')[0], name: k.split('/')[1] }))
  const calls = [['shop/frontend', 'shop/cart'], ['shop/frontend', 'shop/checkout'], ['shop/cart', 'data/redis'],
    ['shop/checkout', 'shop/payments'], ['shop/checkout', 'data/postgres'], ['ingress:shop/storefront', 'shop/frontend']]
    .map(([from, to]) => ({ from, to }))
  const layout = layoutCity(deps, ['node-1', 'node-2', 'node-3'], calls, calls.filter((c) => c.from.startsWith('ingress:')))
  const roads = buildRoads(layout, calls)
  assert.equal(Object.keys(roads).length, calls.length)
  const failures: string[] = []
  const realAssert = console.assert
  console.assert = (ok?: boolean, ...msg: unknown[]) => { if (!ok) failures.push(String(msg[0])) }
  try { checkRoads(layout, roads) } finally { console.assert = realAssert }
  assert.deepEqual(failures, [])
})

test('MiniShop: no Road runs through another Building', async () => {
  const { buildRoads, checkRoads, layoutCity } = await import('../src/layout.ts')
  const fs = await import('node:fs')
  const arch = JSON.parse(fs.readFileSync(new URL('../../minishop/architecture.json', import.meta.url), 'utf8'))
  const deps = arch.components.map((c: { deployment: string }) => ({ namespace: arch.namespace, name: c.deployment }))
  const calls = arch.components.flatMap((c: { deployment: string; dependencies: string[] }) =>
    c.dependencies.map((d) => ({ from: `${arch.namespace}/${c.deployment}`, to: `${arch.namespace}/${d}` })))
  const layout = layoutCity(deps, ['minishop-control-plane', 'minishop-worker'], calls)
  const roads = buildRoads(layout, calls)
  assert.equal(Object.keys(roads).length, 10)
  const failures: string[] = []
  const realAssert = console.assert
  console.assert = (ok?: boolean, ...msg: unknown[]) => { if (!ok) failures.push(String(msg[0])) }
  try { checkRoads(layout, roads) } finally { console.assert = realAssert }
  assert.deepEqual(failures, [])
})

test('partial error rates: about that share of Cars come back orange', () => {
  let cars: CarAgent[] = [], seed = 1, n = 0, errors = 0, served = 0
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
  for (let t = 0; t < 120; t += 1 / 60) {
    if (exitClear(cars) && t * 1.2 > n) cars.push(newCar(n++, rand))
    const r = stepCars(cars, 1 / 60, t, straight(30), { refused: 0, error: 0.25 })
    served += r.served.length
    errors += r.cars.length < cars.length ? cars.filter((c) => !r.cars.includes(c) && c.fate === 'error').length : 0
    cars = r.cars
  }
  const share = errors / (errors + served)
  assert.ok(share > 0.12 && share < 0.4, `error share ${share}`)
})

test('health signals: refused beats errors beats slow; idle when quiet', async () => {
  const { affected, combine, overview, serviceFlow, signalOf, SLOW_MS, tally } = await import('../src/health.ts')
  assert.equal(signalOf({ rps: 0, healthy: true }), 'idle')
  assert.equal(signalOf({ rps: 0, healthy: false }), 'refused')
  assert.equal(signalOf({ rps: 5, error_rate: 0.2, latency_ms: SLOW_MS * 2 }), 'errors')
  assert.equal(signalOf({ rps: 5, error_rate: 0, latency_ms: SLOW_MS * 2 }), 'slow')
  assert.equal(signalOf({ rps: 5, errors: false, healthy: true }), 'ok')                 // an older backend: booleans only
  const c = combine([{ rps: 3, latency_ms: 100, error_rate: 0 }, { rps: 1, latency_ms: null, error_rate: 1 }])
  assert.equal(c.latency_ms, 100); assert.equal(c.error_rate, 0.25)
  const flows = [{ from: 'gate', to: 'a', rps: 8, latency_ms: 50 }, { from: 'a', to: 'b', rps: 4, latency_ms: 20, error_rate: 0.5 }]
  assert.deepEqual([overview(flows).rps, overview(flows).latency_ms], [8, 50])         // users feel the entry
  assert.equal(serviceFlow('gate', flows).basis, 'sent')                               // nobody calls it: judge its calls
  assert.equal(affected({ ready: 2, want: 2, signal: 'errors' })?.label, 'Errors in its answers') // Pods fine, requests failing
  assert.equal(affected({ ready: 0, want: 2, signal: 'idle' })?.rank, 6)
  assert.equal(affected({ ready: 0, want: 0, signal: 'idle' })?.label, 'Down: scaled to zero')            // matches the banner
  assert.equal(affected({ ready: 1, want: 1, signal: 'errors', basis: 'sent' })?.label, 'Errors in the calls it makes')
  assert.equal(overview([{ from: 'gate', to: 'a', rps: 10, error_rate: 0.1 }, { from: 'a', to: 'b', rps: 10 }]).failing, 0.1)
  assert.equal(affected({ ready: 2, want: 2, signal: 'ok' }), null)
  assert.equal(affected({ ready: 0, want: 0, signal: 'idle', missing: true })?.label, 'Not deployed')
  // Counts cut where the city draws a beam: slow / missing Pods are degraded; impacted, errors, down are failed.
  assert.deepEqual(tally([null, affected({ ready: 2, want: 2, signal: 'slow' }), affected({ ready: 1, want: 2, signal: 'ok' }),
    affected({ ready: 2, want: 2, signal: 'ok', impactedBy: 'payments' }), affected({ ready: 2, want: 2, signal: 'errors' }),
    affected({ ready: 0, want: 2, signal: 'idle' })]), { healthy: 1, degraded: 2, failed: 3 })
})
