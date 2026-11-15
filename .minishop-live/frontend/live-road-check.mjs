import assert from 'node:assert/strict'
import fs from 'node:fs'
import { layoutCity } from './src/layout.ts'
import { buildLiveRoads, streetKey } from './src/liveRoads.ts'
const spec = JSON.parse(fs.readFileSync('./architecture-check.json'))
const deployments = spec.components.map(({ deployment: name }) => ({ name, namespace: spec.namespace }))
const calls = spec.components.flatMap(c => (c.dependencies ?? []).map(d => ({from: 'minishop/' + c.id, to: 'minishop/' + d})))
const layout = layoutCity(deployments, ['control-plane','worker'], [], [], true)
const roads = buildLiveRoads(layout, calls)
assert.equal(Object.keys(roads).length, new Set(calls.map(c => streetKey(c.from,c.to))).size)
for (const [key, road] of Object.entries(roads)) {
  for (let i=1;i<road.length;i++) for (const {center} of Object.values(layout.lots)) {
    const a=road[i-1], b=road[i], {x,z}=center
    assert.ok(Math.max(a.x,b.x) <= x-9.3 || Math.min(a.x,b.x) >= x+9.3 ||
      Math.max(a.z,b.z) <= z-9.9 || Math.min(a.z,b.z) >= z+9.1, key)
  }
}
const first = buildLiveRoads(layout,calls.slice(0,1))
for(const key of Object.keys(first)) assert.deepEqual(first[key], roads[key])
const {from,to}=calls[0]
assert.deepEqual(buildLiveRoads(layout,[...calls,{from:to,to:from},calls[0]]), roads)
console.log('Verified',Object.keys(roads).length,'MiniShop streets: clearance, stable first road, reverse reuse')
