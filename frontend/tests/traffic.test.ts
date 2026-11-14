import assert from 'node:assert/strict'
import { test } from 'node:test'
import { admit, bendLimit, type CarAgent, DRIVE, exitClear, newCar, stepCars, type Trip } from '../src/traffic.ts'

const straight = (len: number): Trip => ({ okLength: len, backLength: 2 * len, door: len - 2, limitOk: () => 99, limitBack: () => 99 })

/** Spawn a Car every `every` seconds for `seconds`, stepping at 60 fps. */
function simulate(trip: Trip, healthy: boolean, errors: boolean, seconds: number, every = 0.4) {
  let cars: CarAgent[] = [], served = 0, minGap = Infinity, next = 0, slot = 0
  for (let t = 0; t < seconds; t += 1 / 60) {
    if (t >= next && exitClear(cars)) { cars.push(newCar(slot++, () => 0.5)); next = t + every }
    const r = stepCars(cars, 1 / 60, t, trip, healthy, errors)
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
      cars = stepCars(cars, 1 / 60, t, straight(40), true, false).cars
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
