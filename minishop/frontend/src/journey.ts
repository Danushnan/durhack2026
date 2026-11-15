// Explicit opt-in pairing with the KubeVerse window that opened this shop.
// No basket contents, session identifiers, product names or payloads leave MiniShop.
export type BasketAction = {
  action_id: string; mutation_id: string; refresh_id: string
  mutation: 'pending' | 'succeeded' | 'failed'; refresh: 'pending' | 'succeeded' | 'failed' | 'not_sent'
}
export type CheckoutAction = {
  kind: 'checkout'; action_id: string; request_id: string
  checkout: 'pending' | 'succeeded' | 'failed'; basket_cleared?: boolean
}
type JourneyAction = BasketAction | CheckoutAction
const target = new URLSearchParams(location.search).get('journey_origin')
const origin = (() => {
  try { const url = new URL(target || ''); return /^https?:$/.test(url.protocol) && url.origin === target ? target : null } catch { return null }
})()
export function reportBasketAction(action: JourneyAction) {
  if (origin && window.opener) window.opener.postMessage({type: 'kubeverse:basket-action', action}, origin)
}
async function register<T extends JourneyAction>(action: T): Promise<T> {
  if (origin && window.opener) {
    // Registration failure must never prevent the real shopping operation.
    await new Promise<void>(resolve => {
      const done = () => { clearTimeout(timer); window.removeEventListener('message', receive); resolve() }
      const receive = (event: MessageEvent) => {
        if (event.origin === origin && event.source === window.opener && event.data?.type === 'kubeverse:registered' && event.data.action_id === action.action_id) done()
      }
      const timer = setTimeout(done, 1500)
      window.addEventListener('message', receive)
      reportBasketAction(action)
    })
  }
  return action
}
export async function beginBasketAction(): Promise<BasketAction> {
  return register({action_id: crypto.randomUUID(), mutation_id: crypto.randomUUID(), refresh_id: crypto.randomUUID(), mutation: 'pending', refresh: 'pending'})
}
export async function beginCheckoutAction(): Promise<CheckoutAction> {
  return register({kind: 'checkout', action_id: crypto.randomUUID(), request_id: crypto.randomUUID(), checkout: 'pending'})
}
