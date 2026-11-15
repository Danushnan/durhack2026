import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Vector3 } from 'three'
import { layoutCity, carTrip } from './src/layout.ts'
import { buildLiveRoads } from './src/liveRoads.ts'
import { findRoundabouts, roadSections, roundaboutLane, ROUNDABOUT_ISLAND, ROUNDABOUT_KERB } from './src/roundabouts.ts'
const spec = JSON.parse(readFileSync('architecture-check.json'))
const deployments = spec.components.map(({deployment:name}) => ({name,namespace:spec.namespace}))
const calls = spec.components.flatMap(c => (c.dependencies??[]).map(d=>({from:'minishop/'+c.id,to:'minishop/'+d})))
const layout = layoutCity(deployments,['control-plane','worker'],[],[],true)
const roads = buildLiveRoads(layout,calls)
const junctions = findRoundabouts(layout,roads)
console.log('MiniShop junctions', [...junctions.keys()])
assert.ok(junctions.size)
const p=(x,z)=>new Vector3(x,0,z)
const straight=[p(-10,0),p(0,0),p(10,0)]
const cross=[p(0,-10),p(0,0),p(0,10)]
const turn=[p(-10,0),p(0,0),p(0,10)]
const test = findRoundabouts(layoutCity([],[],[],[],true),{straight,cross,turn})
assert.equal(test.size,1)
assert.equal(roadSections(straight,test).length,2)
const lane=(r,d)=>roundaboutLane(r,d,test)
for (const path of [straight,cross,turn,[...turn].reverse()]) {
  for(const point of carTrip(path,true,lane)) assert.ok(point.length()>ROUNDABOUT_ISLAND+.4)
  const detour=carTrip(path,false,lane)
  assert.ok(detour.filter(v=>v.length()<ROUNDABOUT_KERB).length>=8)
  assert.ok(detour.every((v,i)=>i===0 || v.distanceTo(detour[i-1])>0))
}
console.log('Verified split road surfaces, forward and reverse turns, and car clearance around the island.')
