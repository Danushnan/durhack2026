import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { layoutCity } from './src/layout.ts'
import { buildLiveRoads, streetKey } from './src/liveRoads.ts'
const shop=JSON.parse(readFileSync('architecture-check.json'))
const names=shop.components.map(c=>c.deployment)
const system=[{namespace:'kube-system',name:'coredns'},{namespace:'local-path-storage',name:'local-path-provisioner'}]
const layout=layoutCity([...system,...names.map(name=>({namespace:'minishop',name}))],['master','worker'],[],[],true)
const keys=names.map(name=>'minishop/'+name)
const all=keys.flatMap(from=>keys.filter(to=>to!==from).map(to=>({from,to})))
let maxRoads=0
const overlap=(a,b,c,d,dir,other)=>a[other]===b[other]&&a[other]===c[other]&&c[other]===d[other]&&
Math.min(Math.max(a[dir],b[dir]),Math.max(c[dir],d[dir]))>Math.max(Math.min(a[dir],b[dir]),Math.min(c[dir],d[dir]))+1e-7
for(let seed=1;seed<=100;seed++){
 let s=seed
 const calls=[...all]
 for(let i=calls.length-1;i>0;i--){s=(1664525*s+1013904223)>>>0; const j=s%(i+1);[calls[i],calls[j]]=[calls[j],calls[i]]}
 while(calls.length<100) calls.push(calls[calls.length%all.length])
 const five=buildLiveRoads(layout,calls.slice(0,5))
 const full=buildLiveRoads(layout,calls)
 for (const e of calls) assert.ok(full.routes[streetKey(e.from,e.to)],JSON.stringify({seed,e}))
 for (const [id,road] of Object.entries(five.roads)) assert.deepEqual(full.roads[id],road)
 const roads=Object.values(full.roads)
 maxRoads=Math.max(maxRoads,roads.length)
 const segments=roads.flatMap(r=>r.slice(1).map((p,i)=>[r[i],p]))
 segments.forEach(([a,b],i)=>segments.slice(0,i).forEach(([c,d])=>{
   assert.ok(!overlap(a,b,c,d,'x','z')&&!overlap(a,b,c,d,'z','x'),'pavement overlap in batch '+seed)
 }))
}
console.log('100 shuffled batches verified, maximum physical roads and spurs:',maxRoads)
