export type Action = {action_id: string; mutation_id: string; refresh_id: string; mutation: string; refresh: string}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function validAction(value: unknown): value is Action {
  if (!value || typeof value !== 'object') return false
  const a = value as Action
  return [a.action_id, a.mutation_id, a.refresh_id].every(v => typeof v === 'string' && uuid.test(v)) && a.mutation_id !== a.refresh_id &&
    ['pending', 'succeeded', 'failed'].includes(a.mutation) && ['pending', 'succeeded', 'failed', 'not_sent'].includes(a.refresh)
}

