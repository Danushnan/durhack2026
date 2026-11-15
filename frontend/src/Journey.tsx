import { JOURNEY_SPEEDS, type JourneySpeed } from './journeyPlayback'
import { actionBody, actionPending, validAction } from './journeyProtocol'
import { useEffect, useRef, useState } from 'react'

export type JourneyStep = {focus_service?: string | null; heading: string; what: string; why: string; matters: string; term: string | null; evidence_label: string; key: string; description: string; state: string; event_ids: string[]; from_service: string | null; to_service: string | null; basis: string}
type Evidence = {event_id: string; request_id: string; event: string; service: string; source: string | null; target: string | null; method: string | null; route: string | null; operation: string | null; status: number; error: string | null; latency_ms: number; outcome: string | null}
export type Journey = {requests?: Record<string,string>; kind: 'add_to_basket' | 'checkout'; collection_seconds: number; order_confirmed?: boolean; new_order_confirmed?: boolean; reused_order_confirmed?: boolean; cleanup_failed?: boolean; rollback_observed?: boolean; payment_state?: string; payment_duration_ms?: number | null; action_id: string; source: string; collector_session: string; state: string; collecting: boolean; truncated: boolean; mutation_accepted: boolean; browser: {mutation?: string; refresh?: string; checkout?: string; basket_cleared?: boolean | null}; steps: JourneyStep[]; events: Evidence[]}

export function useJourney(source: string | undefined | null) {
  const [enabled, setEnabled] = useState(false)
  const [following, setFollowing] = useState(true)
  const [speed, setSpeed] = useState<JourneySpeed>(0.5)
  const [journey, setJourney] = useState<Journey | null>(null)
  const [step, setStep] = useState(0)
  const [replayTick, setReplayTick] = useState(0)
  const [error, setError] = useState('')
  const [actions, setActions] = useState<{id: string; kind: 'add_to_basket' | 'checkout'}[]>([])
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
    setFollowing(true)
  }, [source])
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const pair = paired.current
      if (!source || !pair || event.origin !== pair.origin || event.source !== pair.window || event.data?.type !== 'kubeverse:basket-action' || !validAction(event.data.action)) return
      const action = event.data.action
      const current = generation.current
      // Copy only reviewed fields; ignore extra fields from the other website.
      const body = JSON.stringify(actionBody(action))
      const requestHeaders = headers()
      queue.current = queue.current.then(async () => {
        if (current !== generation.current) return
        try {
          const result = await readResponse(await fetch('/api/journeys/actions', {method: 'POST', headers: requestHeaders, body, signal: AbortSignal.timeout(4000)}))
          if (current !== generation.current || result.source !== source) return
          pair.window.postMessage({type: 'kubeverse:registered', action_id: action.action_id}, pair.origin)
          setActions(ids => [{id: action.action_id, kind: action.kind ?? 'add_to_basket'}, ...ids.filter(a => a.id !== action.action_id)].slice(0, 20))
          if (actionPending(action) || selected.current === action.action_id || !selected.current) {
            if (selected.current !== action.action_id) { setStep(0); setFollowing(true) }
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
  return {enabled, setEnabled: (value: boolean) => { setEnabled(value); if (value) setFollowing(true) }, following, setFollowing, speed, setSpeed, journey, step, setStep, replayTick, replay: () => { setFollowing(true); setStep(0); setReplayTick(tick => tick + 1) }, error, actions, actionId, openShop,
    select: (id: string) => { selected.current = id; setActionId(id); setStep(0); setFollowing(true); setJourney(null) }}
}

export function JourneyPanel({controller}: {controller: ReturnType<typeof useJourney>}) {
  const {journey, step, setStep, error, actions, actionId} = controller
  const [shop, setShop] = useState(import.meta.env.VITE_MINISHOP_URL || 'http://127.0.0.1:8090/')
  const current = journey?.steps[step]
  return <aside className="hud journey-panel" aria-label="Guided shopping journey">
    <h2>Journey View</h2>
    <p className="small">Follow one shopping action through the shop.</p>
    <details open={!journey}><summary>Pair MiniShop</summary>
    <label>MiniShop URL<input type="url" value={shop} onChange={e => setShop(e.target.value)} /></label>
    <button onClick={() => controller.openShop(shop)}>Open paired MiniShop ↗</button>
    <p className="small muted">Open the shop here to pair it with this viewer. Place it beside this window, then Add to basket or Place order.</p>
    </details>
    {error && <p role="alert">{error}</p>}
    {actions.length > 0 && <label>Shopping action<select value={actionId ?? ''} onChange={e => controller.select(e.target.value)}>{actions.map((a, i) => <option key={a.id} value={a.id}>{a.kind === 'checkout' ? 'Place Order' : 'Add to Basket'} · {a.id.slice(0, 8)}{i === 0 ? ' · latest' : ''}</option>)}</select></label>}
    <label>Guide speed<select value={controller.speed} onChange={e => controller.setSpeed(Number(e.target.value) as JourneySpeed)}>
      {JOURNEY_SPEEDS.map(speed => <option key={speed} value={speed}>{speed}×{speed === 0.5 ? ' (default)' : ''}</option>)}
    </select></label>
    {!journey && <p role="status">Waiting for a paired shopping action.</p>}
    {journey && <>
      <p role="status"><b>{journey.state}</b>{journey.collecting ? ' · collecting observations' : ' · collection finished'}</p>
      <details><summary>Action outcome{journey.kind === 'checkout' ? journey.order_confirmed ? ' · order confirmed' : journey.payment_state === 'declined' ? ' · payment declined' : '' : journey.mutation_accepted ? ' · basket change accepted' : ''}</summary>
      <p className="small">Collecting late observations for up to {journey.collection_seconds} seconds.</p>
      {journey.kind === 'checkout' ? <>
        <p>Order result: {journey.new_order_confirmed ? 'new order confirmed' : journey.reused_order_confirmed ? 'saved order reused' : journey.order_confirmed ? 'order confirmed; new or reused not established' : 'not confirmed'}. Browser: {journey.browser.checkout}.</p>
        {journey.payment_duration_ms != null && <p>Selected Payment call: <b>{journey.payment_duration_ms.toFixed(2)} ms</b> · {journey.payment_state}. This is one call, separate from rolling health.</p>}
        {journey.cleanup_failed && <p>Basket cleanup failed. Check the separately reported order result before retrying.</p>}
        {journey.rollback_observed && <p>The transaction rolled back. This does not mean PostgreSQL pods failed.</p>}
      </> : <p>Basket change: {journey.mutation_accepted ? 'accepted by Cart' : 'acceptance not confirmed'}. Browser refresh: {journey.browser.refresh}.</p>}
      </details>
      {journey.truncated && <p>Evidence limit reached; this journey may be incomplete.</p>}
      <progress value={step + 1} max={journey.steps.length} aria-label="Journey stage" />
      <p className="small">Stage {step + 1} of {journey.steps.length} · {current?.evidence_label}{current?.state !== 'observed' ? ' · ' : ''}{current?.state !== 'observed' ? current?.state : ''}</p>
      <div className="journey-buttons"><button disabled={step === 0} onClick={() => setStep(step - 1)}>Previous</button><button disabled={step === journey.steps.length - 1} onClick={() => setStep(step + 1)}>Next</button><button onClick={controller.replay}>Replay guide</button></div>
      <h3 className="journey-heading">{current?.heading}</h3>
      <dl className="journey-learning" aria-live="polite">
        <dt>What’s happening?</dt><dd>{current?.what}</dd>
        <dt>Why this component?</dt><dd>{current?.why}</dd>
        <dt>Why does it matter?</dt><dd>{current?.matters}</dd>
      </dl>
      {current?.term && <details><summary>A term explained</summary><p>{current.term}</p></details>}
      <p className="small muted">{current?.basis === 'browser' ? 'Browser report, separate from backend evidence.' : current?.basis === 'inferred' ? 'Inferred from the listed observations and reviewed MiniShop code; not a separately measured operation.' : 'Backend evidence. Missing observations do not prove success.'}</p>
      <details><summary>Actual request and event details</summary><p>Action: <code>{journey.action_id}</code><br/>Collector: <code>{journey.collector_session}</code></p>
        {Object.entries(journey.requests ?? {}).map(([role,id]) => <p key={role}>Registered {role} request: <code>{id}</code></p>)}
        {journey.events.filter(e => current?.event_ids.includes(e.event_id)).map(e => <div key={e.event_id} className="journey-evidence"><code>{e.event}</code> · {e.status} · {e.latency_ms.toFixed(2)} ms<br/>Emitter: {e.service}<br/>Source: {e.source ?? 'not recorded'} · Target: {e.target ?? 'not recorded'}<br/>{e.method ? `${e.method} ` : ''}{e.route ?? e.operation}<br/>Outcome: {e.outcome ?? 'HTTP status'} · Error: {e.error ?? 'none recorded'}<br/>Request: <code>{e.request_id}</code><br/>Event: <code>{e.event_id}</code></div>)}
        {!current?.event_ids.length && <p>No backend event for this stage.</p>}
      </details>
      <details><summary>City legend &amp; replay</summary><p className="small muted">Buildings are services; units are pods; roads are dependencies. Background cars illustrate aggregate activity. The one gold guide represents the selected shopping action across its requests, not one HTTP request. Replay only moves that guide; it never repeats a shopping request or creates another order. Between branches the guide returns to the actual caller. Animation timing is educational.</p></details>
    </>}
  </aside>
}
