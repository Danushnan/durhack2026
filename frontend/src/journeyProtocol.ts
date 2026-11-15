export type BasketAction = {kind?: 'add_to_basket'; action_id: string; mutation_id: string; refresh_id: string; mutation: string; refresh: string}
export type CheckoutAction = {kind: 'checkout'; action_id: string; request_id: string; checkout: string; basket_cleared?: boolean}
export type Action = BasketAction | CheckoutAction
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isId = (value: unknown) => typeof value === 'string' && uuid.test(value)
export function validAction(value: unknown): value is Action {
  if (!value || typeof value !== 'object') return false
  const a = value as Record<string, unknown>
  if (!isId(a.action_id)) return false
  if (a.kind === 'checkout') return isId(a.request_id) && a.mutation_id === undefined && a.refresh_id === undefined &&
    ['pending','succeeded','failed'].includes(a.checkout as string) &&
    (a.basket_cleared === undefined || (typeof a.basket_cleared === 'boolean' && a.checkout === 'succeeded'))
  return (a.kind === undefined || a.kind === 'add_to_basket') && a.request_id === undefined && a.checkout === undefined &&
    isId(a.mutation_id) && isId(a.refresh_id) && a.mutation_id !== a.refresh_id &&
    ['pending', 'succeeded', 'failed'].includes(a.mutation as string) && ['pending', 'succeeded', 'failed', 'not_sent'].includes(a.refresh as string)
}
export function actionBody(action: Action) {
  return action.kind === 'checkout'
    ? {kind: action.kind, action_id: action.action_id, request_id: action.request_id, checkout: action.checkout,
      ...(action.basket_cleared === undefined ? {} : {basket_cleared:action.basket_cleared})}
    : {action_id: action.action_id, mutation_id: action.mutation_id, refresh_id: action.refresh_id, mutation: action.mutation, refresh: action.refresh}
}
export const actionPending = (action: Action) => (action.kind === 'checkout' ? action.checkout : action.mutation) === 'pending'
