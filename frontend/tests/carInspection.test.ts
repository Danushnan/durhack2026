import assert from 'node:assert/strict'
import {test} from 'node:test'
import {discoveryCarDetails, updateHover, type HoverInfo} from '../src/carInspection.ts'

const card: HoverInfo={title:'Cart → Product',lines:['snapshot'],x:10,y:20,pinnedKey:'car-1'}
test('car details stay pinned after pointer-out and incidental building/road hover; re-enter toggles closed', () => {
  let state=updateHover(null,card)
  assert.strictEqual(state,card)
  state=updateHover(state,null)
  assert.strictEqual(state,card)
  state=updateHover(state,{title:'Road',lines:[],x:0,y:0})
  assert.strictEqual(state,card)
  assert.equal(updateHover(state,card),null)
})
test('click keeps an already-hovered card open, another car switches the snapshot, ordinary tooltips still clear', () => {
  assert.equal(updateHover(card,{...card,pinMode:'open'})?.pinnedKey,'car-1')
  assert.equal(updateHover(card,{...card,pinnedKey:'car-2'})?.pinnedKey,'car-2')
  assert.equal(updateHover({...card,pinnedKey:undefined},null),null)
})
test('Discovery car information uses aggregate route measurements and reviewed purpose, without inventing request identity', () => {
  const edge={from:'minishop/checkout-api',to:'minishop/payment-api',healthy:true,requests:3,rps:.6,latency_ms:2000,error_rate:1,refused_rate:0}
  const result=discoveryCarDetails(edge,{phase:'back',fate:'error'})
  assert.equal(result.title,'Checkout → Payment')
  const text=result.lines.join('\n')
  assert.match(text,/Typical purpose:/)
  assert.match(text,/3 instrumented completions in the rolling 5s window/)
  assert.match(text,/2000.0 ms/)
  assert.match(text,/HTTP 402 do not establish a pod outage/)
  assert.match(text,/not one request/)
  assert.match(text,/Failed communication share: 0.0%/)
  const preview=discoveryCarDetails(edge,{phase:'back',fate:'refused'},true,true).lines.join('\n')
  assert.match(preview,/Synthetic refusal/)
  assert.doesNotMatch(preview,/2000|3 instrumented completions/)
})
