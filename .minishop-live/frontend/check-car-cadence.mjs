import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
const city = readFileSync('src/City.tsx', 'utf8')
const code = city.slice(city.indexOf('const LIVE_CAR_INTERVAL_MS'), city.indexOf('export function City'))
let cursor = 0, tick, effects = []
const slots = []
const state = (initial) => {
  const i = cursor++
  if (!(i in slots)) slots[i] = initial
  return [slots[i], fn => { slots[i] = typeof fn === 'function' ? fn(slots[i]) : fn }]
}
const ref = (current) => slots[cursor] ??= { current }
const useRef = (current) => { const r = ref(current); cursor++; return r }
const useEffect = (fn, deps) => {
  const i = cursor++
  if (!slots[i] || deps.some((value, j) => value !== slots[i][j])) {
    slots[i] = deps
    effects.push(fn)
  }
}
const timer = { setInterval(fn, ms) { assert.equal(ms, 5000); tick = fn }, clearInterval() {} }
const useCars = new Function('useState', 'useRef', 'useEffect', 'window', stripTypeScriptTypes(code) + '; return useLiveCars')(state, useRef, useEffect, timer)
function render(edges) {
  cursor = 0
  const result = useCars('kind-minishop', edges, false)
  effects.splice(0).forEach(fn => fn())
  return result
}
const a = { from: 'shop/web', to: 'shop/cart', requests: 50 }
const b = { from: 'shop/cart', to: 'shop/data', requests: 20 }
assert.deepEqual(render([a,b]), [])
tick()
assert.deepEqual(render([a,b]), [])
const newEdges = [{...a, requests:51},{...b, requests:21}]
assert.deepEqual(render(newEdges), [])
tick()
assert.deepEqual(render(newEdges).map(e=>[e.to,e.requests]), [['shop/cart',1]])
tick()
assert.deepEqual(render(newEdges).map(e=>[e.to,e.requests]), [['shop/cart',1],['shop/data',1]])
tick()
assert.deepEqual(render(newEdges).map(e=>e.requests), [1,1])
console.log('No roads initially; one admitted car per 5-second tick; no cars without new requests.')

