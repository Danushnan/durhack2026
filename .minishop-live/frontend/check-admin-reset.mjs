import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
const city='http://127.0.0.1:15173'
const origin='http://127.0.0.1:18080'
const socket=new WebSocket('ws://127.0.0.1:15173/ws')
const events=[]
socket.onmessage=({data})=>events.push(...JSON.parse(data))
await once(socket,'open')
const get=async(predicate)=>{
  for(let i=0;i<60;i++){const event=events.find(predicate);if(event)return event;await new Promise(r=>setTimeout(r,100))}
  throw Error('No matching WebSocket event')
}
try {
  await get(e=>e.type==='SOURCE')
  const send=await fetch(city+'/api/demo/traffic',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({count:5,cross_district:true})})
  assert.equal(send.status,200)
  const traffic=await get(e=>e.type==='DEMO_TRAFFIC')
  assert.equal(traffic.edges.length,5)
  const reset=await fetch(city+'/api/demo/traffic/reset',{method:'POST',headers:{origin}})
  assert.equal(reset.status,200)
  const cleared=await get(e=>e.type==='DEMO_RESET')
  let state, runEffect
  const useState=(initial)=>{state=initial;return [state, update=>{state=typeof update==='function'?update(state):update}]}
  const useEffect=(fn)=>{runEffect=fn}
  let watch
  class FakeSocket { constructor(){watch=this} }
  const source=readFileSync('src/k8s.ts','utf8').split('export function useCluster()')[1].split('export const ACTION_FAILED')[0]
  new Function('useState','useEffect','WebSocket','location','window',
    stripTypeScriptTypes('function useCluster()'+source)+';return useCluster()')
    (useState,useEffect,FakeSocket,{protocol:'http:',host:'example'},{setTimeout:fn=>fn()})
  runEffect()
  watch.onopen()
  watch.onmessage({data:JSON.stringify(events.filter(e=>e.type==='ADDED'))})
  const objects=state.objects
  watch.onmessage({data:JSON.stringify([traffic])})
  assert.ok(state.demoEdges.length)
  watch.onmessage({data:JSON.stringify([cleared])})
  assert.deepEqual(state.demoEdges,[])
  assert.equal(state.demoRevision,1)
  assert.deepEqual(state.objects,objects)
  console.log('Reset cleared live demo routes and vehicle counters while retaining cluster resources.')
} finally { socket.close() }

