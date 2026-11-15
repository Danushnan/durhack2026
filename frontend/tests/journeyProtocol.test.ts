import assert from 'node:assert/strict'
import { test } from 'node:test'
import { validAction } from '../src/journeyProtocol.ts'

test('accepts an explicitly paired action with distinct request IDs and reviewed outcomes', () => {
  const a = {action_id: crypto.randomUUID(), mutation_id: crypto.randomUUID(), refresh_id: crypto.randomUUID(), mutation: 'pending', refresh: 'pending'}
  assert.ok(validAction(a))
  assert.ok(validAction({...a, mutation: 'succeeded', refresh: 'failed'}))
  assert.ok(validAction({...a, mutation: 'failed', refresh: 'not_sent'}))
  assert.equal(validAction({...a, refresh_id: a.mutation_id}), false)
  assert.equal(validAction({...a, mutation_id: 'latest-global-request'}), false)
  assert.equal(validAction({...a, mutation: 'invented-success'}), false)
  assert.equal(validAction(null), false)
})
