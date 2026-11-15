import { validAction } from './journeyProtocol'
import { useEffect, useRef, useState } from 'react'

export type JourneyStep = {key: string; description: string; state: string; event_ids: string[]; from_service: string | null; to_service: string | null; basis: string}
type Evidence = {event_id: string; request_id: string; event: string; service: string; source: string | null; target: string | null; method: string | null; route: string | null; operation: string | null; status: number; latency_ms: number; outcome: string | null}
export type Journey = {action_id: string; source: string; collector_session: string; state: string; collecting: boolean; truncated: boolean; mutation_accepted: boolean; browser: {mutation: string; refresh: string}; steps: JourneyStep[]; events: Evidence[]}

export function useJourney(source: string | undefined | null) {
  const [enabled, setEnabled] = useState(false)
  const [journey, setJourney] = useState<Journey | null>(null)
  const [step, setStep] = useState(0)
  const [replayTick, setReplayTick] = useState(0)
  const [error, setError] = useState('')
  const [actions, setActions] = useState<string[]>([])
  const [actionId, setActionId] = useState<string | null>(null)
  const viewer = useRef(crypto.randomUUID())
  const paired = useRef<{window: Window; origin: string} | null>(null)
  const generation = useRef(0)
  const selected = useRef<string | null>(null)
  const queue = useRef(Promise.resolve())
  const headers = () => ({'Content-Type': 'application/json', Authorization: `Bearer ${viewer.current}`})
  const readResponse = async (response: Response): Promise<Journey> => {
    const body = await response.json()
    if (!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : 'Journey unavailable')
    return body
  }
  useEffect(() => {
    generation.current++
    paired.current = null; selected.current = null
    setJourney(null); setActionId(null); setActions([]); setStep(0); setError(''); setEnabled(false)
    viewer.current = crypto.randomUUID()
  }, [source])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const pair = paired.current
      if (!source || !pair || event.origin !== pair.origin || event.source !== pair.window || event.data?.type !== 'kubeverse:basket-action' || !validAction(event.data.action)) return
      const action = event.data.action
      const current = generation.current
      // Copy only reviewed fields; ignore extra fields from the other website.
      const body = JSON.stringify({action_id: action.action_id, mutation_id: action.mutation_id, refresh_id: action.refresh_id, mutation: action.mutation, refresh: action.refresh})
      const requestHeaders = headers()
      queue.current = queue.current.then(async () => {
        if (current !== generation.current) return
        try {
          const result = await readResponse(await fetch('/api/journeys/actions', {method: 'POST', headers: requestHeaders, body, signal: AbortSignal.timeout(4000)}))
          if (current !== generation.current || result.source !== source) return
          pair.window.postMessage({type: 'kubeverse:registered', action_id: action.action_id}, pair.origin)
          setActions(ids => [action.action_id, ...ids.filter(id => id !== action.action_id)].slice(0, 20))
          if (action.mutation === 'pending' || selected.current === action.action_id || !selected.current) {
            if (selected.current !== action.action_id) setStep(0)
            selected.current = action.action_id; setActionId(action.action_id); setJourney(result)
          }
          setError('')
        } catch (e) { if (current === generation.current) setError(String(e instanceof Error ? e.message : e)) }
      })
    }
    window.addEventListener('message', receive)
    return () => window.removeEventListener('message', receive)
  }, [source])
  useEffect(() => {
    if (!actionId || !source) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      try {
        const result = await readResponse(await fetch(`/api/journeys/${actionId}`, {headers: headers(), signal: AbortSignal.timeout(4000)}))
        if (cancelled) return
        if (result.source !== source) { setJourney(null); setError('Source changed; open a new paired shop.'); return }
        setJourney(result); setError('')
        if (result.collecting) timer = setTimeout(poll, 1000)
      } catch (e) { if (!cancelled) { setJourney(null); setError(String(e instanceof Error ? e.message : e)) } }
    }
    void poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [actionId, source])
  const openShop = (value: string) => {
    try {
      const url = new URL(value)
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error('Use an HTTP or HTTPS shop URL')
      url.searchParams.set('journey_origin', location.origin)
      const shop = window.open(url, '_blank')
      if (!shop) throw new Error('Allow popups to pair MiniShop')
      paired.current = {window: shop, origin: url.origin}; setError('')
    } catch (e) { setError(String(e instanceof Error ? e.message : e)) }
  }
  return {enabled, setEnabled, journey, step, setStep, replayTick, replay: () => { setStep(0); setReplayTick(tick => tick + 1) }, error, actions, actionId, openShop,
    select: (id: string) => { selected.current = id; setActionId(id); setStep(0); setJourney(null) }}
}

export function JourneyPanel({controller}: {controller: ReturnType<typeof useJourney>}) {
  const {journey, step, setStep, error, actions, actionId} = controller
  const [shop, setShop] = useState(import.meta.env.VITE_MINISHOP_URL || 'http://127.0.0.1:8090/')
  const current = journey?.steps[step]
  return <aside className="hud journey-panel" aria-label="Guided shopping journey">
    <h2>Journey View</h2>
    <p>Follow one Add to Basket action across two requests. The gold guide represents the action, not one HTTP request.</p>
    <details open={!journey}><summary>Pair MiniShop</summary>
    <label>MiniShop URL<input type="url" value={shop} onChange={e => setShop(e.target.value)} /></label>
    <button onClick={() => controller.openShop(shop)}>Open paired MiniShop ↗</button>
    <p className="small muted">Place the shop beside this window, then click Add to basket. Registration requires KUBEVERSE_JOURNEYS=1 on the local backend.</p>
    </details>
    {error && <p role="alert">{error}</p>}
    {actions.length > 0 && <label>Shopping action<select value={actionId ?? ''} onChange={e => controller.select(e.target.value)}>{actions.map((id, i) => <option key={id} value={id}>Add to Basket · {id.slice(0, 8)}{i === 0 ? ' · latest' : ''}</option>)}</select></label>}
    {!journey && <p role="status">Waiting for a paired shopping action.</p>}
    {journey && <>
      <p role="status"><b>{journey.state}</b>{journey.collecting ? ' · collecting late observations (up to 30 seconds)' : ' · collection finished'}</p>
      <p>Mutation: {journey.mutation_accepted ? 'accepted by Cart' : 'acceptance not confirmed'}. Browser refresh: {journey.browser.refresh}.</p>
      {journey.truncated && <p>Evidence limit reached; this journey may be incomplete.</p>}
      <progress value={step + 1} max={journey.steps.length} aria-label="Journey stage" />
      <h3>Stage {step + 1} of {journey.steps.length} · {current?.state}</h3>
      <p aria-live="polite">{current?.description}</p>
      <p className="small muted">{current?.basis === 'browser' ? 'Browser report, separate from backend evidence.' : 'Backend evidence. Missing observations do not prove success.'} Between branches the guide returns focus to the caller. Animation timing is educational.</p>
      <div className="journey-buttons"><button disabled={step === 0} onClick={() => setStep(step - 1)}>Previous</button><button disabled={step === journey.steps.length - 1} onClick={() => setStep(step + 1)}>Next</button><button onClick={controller.replay}>Replay guide</button></div>
      <details><summary>Actual request and event details</summary><p>Action: <code>{journey.action_id}</code><br/>Collector: <code>{journey.collector_session}</code></p>
        {journey.events.filter(e => current?.event_ids.includes(e.event_id)).map(e => <div key={e.event_id} className="journey-evidence"><code>{e.event}</code> · {e.status} · {e.latency_ms.toFixed(2)} ms<br/>{e.service} → {e.target ?? 'response'}<br/>{e.method ? `${e.method} ` : ''}{e.route ?? e.operation}<br/>Outcome: {e.outcome ?? 'HTTP status'}<br/>Request: <code>{e.request_id}</code><br/>Event: <code>{e.event_id}</code></div>)}
        {!current?.event_ids.length && <p>No backend event for this stage.</p>}
      </details>
      <p className="small muted">Replay only moves the guide; it never repeats a shopping request. Buildings are services; units are pods; roads are dependencies. Traffic cars illustrate aggregate activity.</p>
    </>}
  </aside>
}
