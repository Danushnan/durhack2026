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
  for (const [name, point] of key.split(">").map((name, index) => [name, index === 0 ? road[0] : road.at(-1)])) {
    const { center } = layout.lots[name]
    assert.ok(Math.abs(point.x-center.x) < 7 && point.z-center.z > -7.6 && point.z-center.z < 6.8, "joined apron " + name)
  }
  for (let i=1;i<road.length;i++) for (const lot of Object.values(layout.lots)) {
    const [from,to] = key.split(">")
    if ((i===1 && lot.key===from) || (i===road.length-1 && lot.key===to)) continue
    const {center} = lot
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

