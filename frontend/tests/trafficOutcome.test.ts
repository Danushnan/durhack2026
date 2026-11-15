import assert from 'node:assert/strict'
import { test } from 'node:test'
import { trafficOutcomeRates } from '../src/trafficOutcome.ts'
import { initialClusterState, reduceWatchMessage } from '../src/watch.ts'

const edge = { from: 'minishop/checkout-api', to: 'minishop/payment-api', rps: 1, healthy: true, refused_rate: .25, error_rate: .5 }
test('real animation uses measured outcomes, independently of preview refusal flags', () => {
  assert.deepEqual(trafficOutcomeRates(edge, false, true), { refused: .25, error: .5 })
  assert.deepEqual(trafficOutcomeRates({...edge, refused_rate: 0, error_rate: 1}, false), {refused: 0, error: 1})
})
test('preview outcomes are explicit illustrations and never inherit measured failures', () => {
  assert.deepEqual(trafficOutcomeRates(edge, true), {refused: 0, error: 0})
  assert.deepEqual(trafficOutcomeRates(edge, true, true), {refused: 1, error: 0})
})
test('synthetic refusal events do not change measured edges or metrics and reset on reconnect/source changes', () => {
  const initial = {...initialClusterState(), connected: true, context: 'test', edges: [edge]}
  const event = {type: 'DEMO_REFUSAL', context:'test', source:edge.from, target:edge.to}
  const state = reduceWatchMessage(initial, [event])
  assert.strictEqual(state.edges, initial.edges)
  assert.strictEqual(state.metrics, initial.metrics)
  assert.equal(Object.values(state.demoPackets!.routes)[0].refused, true)
  assert.equal(reduceWatchMessage(state, [{...event,context:'wrong'}]).demoPackets, state.demoPackets)
  assert.equal(reduceWatchMessage({...state,awaitingSnapshot:true}, [{type:'SOURCE',context:'test'}]).demoPackets, undefined)
  assert.equal(reduceWatchMessage(state, [{type:'SOURCE',context:'other'}]).demoPackets, undefined)
  assert.deepEqual(reduceWatchMessage(state, [{type:'DEMO_PACKETS_RESET'}]).demoPackets?.routes, {})
})
