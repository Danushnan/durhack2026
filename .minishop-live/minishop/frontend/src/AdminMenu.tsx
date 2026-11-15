import { useState } from 'react'

const cityUrl = import.meta.env.VITE_KUEBEC_URL || 'http://127.0.0.1:15173'
const actions = [
  { label: 'Send a single request', count: 1, cross_district: false },
  { label: 'Send 5 requests', count: 5, cross_district: false },
  { label: 'Send 1 cross-district request', count: 1, cross_district: true },
  { label: 'Send 5 cross-district requests', count: 5, cross_district: true },
  { label: 'Send 100 requests', count: 100, cross_district: false },
]

export function AdminMenu() {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  async function runAction(action?: typeof actions[number]) {
    setBusy(true)
    setMessage('')
    try {
      const response = await fetch(new URL(action ? '/api/demo/traffic' : '/api/demo/traffic/reset', cityUrl), {
        method: 'POST',
        headers: action ? { 'Content-Type': 'application/json' } : undefined,
        body: action ? JSON.stringify({ count: action.count, cross_district: action.cross_district }) : undefined,
        signal: AbortSignal.timeout(5000),
      })
      const result = await response.json()
      if (!response.ok) throw new Error(typeof result.detail === 'string' ? result.detail : 'Kuebec could not complete the action.')
      if (!action) {
        setMessage('Vehicles and roads cleared.')
        return
      }
      const vehicle = action.cross_district ? (result.sent === 1 ? 'lorry' : 'lorries') : (result.sent === 1 ? 'car' : 'cars')
      setMessage(`Sent ${result.sent} ${vehicle} to the live city.`)
    } catch (error) {
      setMessage(error instanceof TypeError || error instanceof DOMException
        ? 'Could not reach Kuebec. Check that the live city is running.'
        : (error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="admin-menu" aria-label="Demo traffic controls">
      <button type="button" aria-expanded={open} aria-controls="demo-traffic-controls"
        onClick={() => setOpen(!open)}>Admin menu</button>
      {open && (
        <div id="demo-traffic-controls" className="admin-menu-actions">
          {actions.map((action) => <button key={action.label} type="button" disabled={busy}
            className={action.count === 100 ? 'admin-burst' : undefined}
            onClick={() => void runAction(action)}>{action.label}</button>)}
          <button type="button">Overload requests to 1 API</button>
          <button type="button" disabled={busy} onClick={() => void runAction()}>Reset</button>
          <p role="status">{message}</p>
        </div>
      )}
    </section>
  )
}
