import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { layoutCity, carTrip } from './src/layout.ts'
import { buildLiveRoads, streetKey } from './src/liveRoads.ts'
import { roundaboutLane, roadSections } from './src/roundabouts.ts'
const {deployments,nodes,calls}=JSON.parse(readFileSync('check-highway-fixture.json'))
const layout=layoutCity(deployments,nodes,[],[],true)
const ns=k=>k.split('/')[0]
const local=calls.filter(c=>ns(c.from)===ns(c.to))
const interstate=calls.filter(c=>ns(c.from)!==ns(c.to))
const network=buildLiveRoads(layout,[...local,...interstate])
console.log('highways', [...network.highways])
console.log('unrouted',calls.filter(c=>!network.routes[streetKey(c.from,c.to)]))
console.log('branch merge roads',Object.keys(network.roads).filter(k=>k.split('>').some(endpoint=>endpoint.includes(',')&&!endpoint.includes('/'))))
assert.equal(network.highways.size,new Set(interstate.map(({from,to})=>streetKey(ns(from),ns(to)))).size)
for(const {from,to} of calls) {
 const route=network.routes[streetKey(from,to)]
 assert.ok(route, from+' -> '+to)
 assert.ok(route.every((p,i)=>i===0||!p.equals(route[i-1])))
 const trip=carTrip(route,true,(r,d)=>roundaboutLane(r,d,network.roundabouts))
 assert.ok(trip.length>2)
}
for(const road of Object.values(network.roads)) assert.ok(roadSections(road,network.roundabouts).every(part=>part.length>=2))
const repeat=buildLiveRoads(layout,[...local,...interstate,...interstate.map(({from,to})=>({from:to,to:from}))])
assert.deepEqual(repeat.roads,network.roads)
assert.deepEqual(repeat.highways,network.highways)
const original=buildLiveRoads(layout,calls)
console.log('original order highways/routes',original.highways.size,Object.keys(original.routes).length,'of',calls.length)
