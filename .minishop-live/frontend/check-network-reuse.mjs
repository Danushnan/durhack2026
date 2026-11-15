import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Vector3 } from 'three'
import { carTrip, layoutCity } from './src/layout.ts'
import { buildLiveRoads, streetKey } from './src/liveRoads.ts'
import { findRoundabouts, roundaboutRoutes, roundaboutLane } from './src/roundabouts.ts'
const p=(x,z)=>new Vector3(x,0,z)
const crossing={'a>b':[p(-10,0),p(0,0),p(10,0)],'c>d':[p(0,-10),p(0,0),p(0,10)]}
const empty=layoutCity([],[],[],[],true)
assert.equal(roundaboutRoutes(crossing,new Map())('a','d'),undefined)
const junctions=findRoundabouts(empty,crossing)
const route=roundaboutRoutes(crossing,junctions)
assert.deepEqual(route('a','d'),[p(-10,0),p(0,0),p(0,10)])
assert.deepEqual(route('d','a'),[p(0,10),p(0,0),p(-10,0)])
assert.ok(carTrip(route('a','d'),false,(r,d)=>roundaboutLane(r,d,junctions)).length>3)
const spec=JSON.parse(readFileSync('architecture-check.json'))
const keys=spec.components.map(c=>spec.namespace+'/'+c.deployment)
const deployments=spec.components.map(({deployment:name})=>({name,namespace:spec.namespace}))
const calls=spec.components.flatMap(c=>(c.dependencies??[]).map(d=>({from:spec.namespace+'/'+c.deployment,to:spec.namespace+'/'+d})))
const layout=layoutCity(deployments,['control-plane','worker'],[],[],true)
const before=buildLiveRoads(layout,calls)
const known=roundaboutRoutes(before.roads,before.roundabouts)
const transfer=keys.flatMap(from=>keys.filter(to=>from<to).map(to=>({from,to}))).find(({from,to})=>!before.routes[streetKey(from,to)] && known(from,to))
assert.ok(transfer)
const key=streetKey(transfer.from,transfer.to)
const after=buildLiveRoads(layout,[...calls,transfer])
assert.deepEqual(after.roads,before.roads)
assert.deepEqual(after.roundabouts,before.roundabouts)
assert.deepEqual(after.routes[key],known(transfer.from,transfer.to))
console.log('Existing streets reused for',key,'via',after.routes[key].length,'waypoints. Physical street count:',Object.keys(after.roads).length)
