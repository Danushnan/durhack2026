import assert from 'node:assert/strict'
import { once } from 'node:events'
import { layoutCity } from './src/layout.ts'
import { buildLiveRoads, streetKey } from './src/liveRoads.ts'
const origin='http://127.0.0.1:18080'
const url='http://127.0.0.1:15173/api/demo/traffic'
const ns=key=>key.split('/')[0]
const ws=new WebSocket('ws://127.0.0.1:15173/ws')
const stream=[]
ws.onmessage=({data})=>stream.push(...JSON.parse(data))
await once(ws,'open')
const wait=async(fn)=>{
  for(let i=0;i<60;i++){const value=fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,100))}
  throw Error('Live event timed out')
}
try {
 assert.equal((await wait(()=>stream.find(e=>e.type==='SOURCE'))).context,'kind-minishop')
 assert.equal(stream.filter(e=>e.type==='DEMO_TRAFFIC').length,0)
 const preflight=await fetch(url,{method:'OPTIONS',headers:{origin,'access-control-request-method':'POST','access-control-request-headers':'content-type'}})
 assert.equal(preflight.headers.get('access-control-allow-origin'),origin)
 const objects=stream.filter(e=>e.type==='ADDED').map(e=>e.object)
 const deployments=objects.filter(o=>o.kind==='Deployment').map(({metadata:{name,namespace}})=>({name,namespace}))
 const nodes=objects.filter(o=>o.kind==='Node').map(o=>o.metadata.name)
 const layout=layoutCity(deployments,nodes,[],[],true)
 const calls=[]
 for(const [index,[count,cross_district]] of [[1,false],[5,false],[1,true],[5,true]].entries()){
   const r=await fetch(url,{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({count,cross_district})})
   const body=await r.json()
   assert.equal(r.status,200,JSON.stringify(body))
   assert.equal(body.sent,count)
   const {edges}=await wait(()=>stream.filter(e=>e.type==='DEMO_TRAFFIC')[index])
   assert.equal(edges.length,count)
   assert.equal(new Set(edges.map(e=>e.from)).size,count)
   assert.ok(edges.every(e=>e.from!==e.to && (ns(e.from)!==ns(e.to))===cross_district))
   calls.push(...edges)
   const {routes}=buildLiveRoads(layout,calls)
   for(const e of calls) assert.ok(routes[streetKey(e.from,e.to)],'missing physical route: '+e.from+' to '+e.to)
   console.log('Verified', count,cross_district?'lorry request(s)':'car request(s)')
 }
} finally { ws.close() }
