import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {ClusterState,Edge} from '../src/k8s.ts'
import {connectionPurpose,recentConnections} from '../src/discoveryActivity.ts'
import {roadKey,startDiscovery} from '../src/roadDiscovery.ts'
import {snapshot} from './liveMetrics.fixture.ts'

const edge=(from:string,to:string,requests=2):Edge=>({from:`minishop/${from}`,to:`minishop/${to}`,requests,rps:requests/5,healthy:true,latency_ms:12.5,error_rate:0,refused_rate:0})
function setup(edges:Edge[]){
 const metrics=snapshot()
 const cluster:ClusterState={connected:true,context:metrics.context,stale:false,metrics,edges,objects:Object.fromEntries(metrics.services.map(s=>[s.deployment_uid!,{kind:'Deployment',metadata:{uid:s.deployment_uid!,name:s.service.split('/')[1],namespace:s.namespace}}]))}
 const discovery={...startDiscovery(metrics.source_id,0),armed:true,roads:new Set(edges.map(roadKey))}
 return {cluster,discovery}
}

test('current rolling window is sorted by measured activity, never accumulated or reinterpreted as new events',()=>{
 const product=edge('cart-api','product-api',2),redis=edge('cart-api','redis',4),catalogue=edge('product-api','postgres',1)
 const {cluster,discovery}=setup([product,redis,catalogue])
 const before=JSON.stringify(cluster)
 assert.deepEqual(recentConnections(cluster,discovery),[redis,product,catalogue])
 assert.equal(cluster.metrics!.window.seconds,10,'Service metrics have a different window from TRAFFIC')
 for(let tick=0;tick<4;tick++)assert.deepEqual(recentConnections({...cluster},discovery).map(e=>e.requests),[4,2,1])
 assert.equal(JSON.stringify(cluster),before)
 const reduced={...cluster,edges:[{...redis,requests:1,rps:.2}]}
 assert.equal(recentConnections(reduced,discovery)[0].requests,1)
 assert.equal(recentConnections({...cluster,edges:[{...redis,requests:0,rps:0}]},discovery).length,0)
 assert.ok(discovery.roads.has(roadKey(redis)),'Going idle retains the revealed dependency')
})

test('unarmed/reset discovery, source changes, stale or incomplete telemetry do not claim current activity',()=>{
 const {cluster,discovery}=setup([edge('cart-api','redis')])
 assert.deepEqual(recentConnections(cluster,{...discovery,armed:false}),[])
 assert.deepEqual(recentConnections(cluster,{...discovery,roads:new Set()}),[])
 assert.deepEqual(recentConnections(cluster,{...discovery,source:'different-source'}),[])
 for(const change of [{connected:false},{stale:true},{awaitingSnapshot:true},{metricsStale:true},{metricsError:'invalid'},{context:null}]){
   assert.deepEqual(recentConnections({...cluster,...change},discovery),[])
 }
 assert.deepEqual(recentConnections({...cluster,metrics:{...cluster.metrics!,source:{...cluster.metrics!.source,status:'degraded'}}},discovery),[])
 const incomplete={...cluster,metrics:{...cluster.metrics!,services:cluster.metrics!.services.map(s=>s.service==='minishop/cart-api'?{...s,window_complete:false}:s)}}
 assert.deepEqual(recentConnections(incomplete,discovery),[])
})

test('requires genuine measured counts, existing source workloads and a discovered directed edge; map previews are excluded',()=>{
 const base=edge('cart-api','redis')
 const {cluster,discovery}=setup([base])
 for(const patch of [{requests:undefined},{requests:-1},{requests:.5},{rps:NaN},{rps:0}]){
  assert.deepEqual(recentConnections({...cluster,edges:[{...base,...patch}]},discovery),[])
 }
 assert.deepEqual(recentConnections({...cluster,objects:{}},discovery),[])
 assert.deepEqual(recentConnections({...cluster,edges:[edge('redis','cart-api')]},discovery),[])
 assert.deepEqual(recentConnections({...cluster,edges:[],demoPackets:{routes:{[roadKey(base)]:{call:base,count:100}},last:{},reset:0}},discovery),[])
})

test('reviewed MiniShop explanations distinguish HTTP from instrumented stores without inventing operations',()=>{
 assert.equal(connectionPurpose(edge('cart-api','product-api')).kind,'HTTP')
 assert.match(connectionPurpose(edge('cart-api','product-api')).description,/validate items or display basket details/)
 assert.equal(connectionPurpose(edge('cart-api','redis')).kind,'Cache operation')
 assert.equal(connectionPurpose(edge('product-api','postgres')).kind,'Database operation')
 assert.match(connectionPurpose(edge('checkout-api','postgres')).description,/reads saved orders or coordinates saving/)
 assert.equal(connectionPurpose(edge('postgres','redis')).kind,'Measured communication')
 assert.match(connectionPurpose(edge('postgres','redis')).description,/has not been reviewed/)
 const unrelated=connectionPurpose({from:'other/cart-api',to:'other/product-api'})
 assert.equal(unrelated.kind,'Measured communication')
 assert.equal(unrelated.source,'other/cart-api')
})
