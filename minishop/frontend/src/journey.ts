// Explicit opt-in pairing with the KubeVerse window that opened this shop.
// No basket contents, session identifiers, product names or payloads leave MiniShop.
export type BasketAction = {
  action_id: string; mutation_id: string; refresh_id: string
  mutation: 'pending' | 'succeeded' | 'failed'; refresh: 'pending' | 'succeeded' | 'failed' | 'not_sent'
}
const target = new URLSearchParams(location.search).get('journey_origin')
const origin = (() => {
  try { const url = new URL(target || ''); return /^https?:$/.test(url.protocol) && url.origin === target ? target : null } catch { return null }
})()
export function reportBasketAction(action: BasketAction) {
  if (origin && window.opener) window.opener.postMessage({type: 'kubeverse:basket-action', action}, origin)
}
export async function beginBasketAction(): Promise<BasketAction> {
  const action: BasketAction = {action_id: crypto.randomUUID(), mutation_id: crypto.randomUUID(), refresh_id: crypto.randomUUID(), mutation: 'pending', refresh: 'pending'}
  if (origin && window.opener) {
    // Register before shopping starts. Pairing failure never prevents a real shop operation.
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
