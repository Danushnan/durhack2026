import assert from 'node:assert/strict'
import { once } from 'node:events'
import { layoutCity } from './src/layout.ts'
import { buildLiveRoads, streetKey } from './src/liveRoads.ts'
const url='http://127.0.0.1:15173/api/demo/traffic',origin='http://127.0.0.1:18080'
const ws=new WebSocket('ws://127.0.0.1:15173/ws')
const stream=[]
ws.onmessage=({data})=>stream.push(...JSON.parse(data))
await once(ws,'open')
const wait=async(fn)=>{
  for(let i=0;i<60;i++){const value=fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100))}
  throw Error('Live event timed out')
}
try {
 await wait(()=>stream.find(e=>e.type==='SOURCE'))
 const response=await fetch(url,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({count:100,cross_district:false})})
 assert.equal(response.status,200)
 assert.equal((await response.json()).sent,100)
 const {edges}=await wait(()=>stream.find(e=>e.type==='DEMO_TRAFFIC'))
 assert.equal(edges.length,100)
 assert.ok(edges.every(e=>e.from!==e.to&&e.from.split('/')[0]===e.to.split('/')[0]))
 const objects=stream.filter(e=>e.type==='ADDED').map(e=>e.object)
 const deployments=objects.filter(o=>o.kind==='Deployment').map(({metadata:{name,namespace}})=>({name,namespace}))
 const nodes=objects.filter(o=>o.kind==='Node').map(o=>o.metadata.name)
 const {routes}=buildLiveRoads(layoutCity(deployments,nodes,[],[],true),edges)
 assert.ok(edges.every(e=>routes[streetKey(e.from,e.to)]))
 console.log('100 requests received in one WebSocket event, all with valid in-district routes.')
} finally {
 await fetch(url+'/reset',{method:'POST',headers:{origin}})
 ws.close()
}
