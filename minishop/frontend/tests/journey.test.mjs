import {readFileSync} from 'node:fs'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import ts from 'typescript'

const code=ts.transpileModule(readFileSync(new URL('../src/journey.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText

test('sequential and concurrent basket actions allocate independent pairs; only the paired opener receives metadata',async()=>{
  globalThis.location={search:'?journey_origin=http%3A%2F%2Flocalhost%3A5181'}
  const listeners=new Set(), reports=[]
  const opener={postMessage(message,origin){
    reports.push({message,origin})
    queueMicrotask(()=>{for(const receive of listeners)receive({origin,source:opener,data:{type:'kubeverse:registered',action_id:message.action.action_id}})})
  }}
  globalThis.window={opener,addEventListener(type,fn){listeners.add(fn)},removeEventListener(type,fn){listeners.delete(fn)}}
  const module=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'))
  const first=await module.beginBasketAction()
  const [second,third]=await Promise.all([module.beginBasketAction(),module.beginBasketAction()])
  assert.equal(new Set([first,second,third].flatMap(a=>[a.action_id,a.mutation_id,a.refresh_id])).size,9)
  first.mutation='succeeded';first.refresh='failed';module.reportBasketAction(first)
  assert.equal(reports.length,4)
  assert.equal(reports[3].message.action.refresh,'failed')
  assert.ok(reports.every(r=>r.origin==='http://localhost:5181'))
  assert.equal(listeners.size,0)
  assert.deepEqual(Object.keys(first).sort(),['action_id','mutation','mutation_id','refresh','refresh_id'])
})
