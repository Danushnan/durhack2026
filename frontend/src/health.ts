/**
 * Request health, kept apart from Pod health. Pods say whether copies of a service are running and
 * ready; requests say whether it actually does its job (answers, quickly, without errors). A service
 * can have every Pod ready and still fail requests (a payment provider declining, a broken dependency).
 *
 * Pure: no React, no three.js. One signal function and one palette feed Roads, Buildings, the
 * overview and the legend, so they never disagree.
 */

/** The fields of a Road this needs (an Edge from the watch stream, or a telemetry row). */
export interface Flow {
  from?: string
  to?: string
  rps: number
  healthy?: boolean
  errors?: boolean
  latency_ms?: number | null
  error_rate?: number
  refused_rate?: number
}

// Thresholds, shown in the legend so every colour is explainable.
export const SLOW_MS = 300        // average answer slower than this → slow
export const ERROR_RATE = 0.01    // at least 1% of requests fail → errors

export type Signal = 'idle' | 'ok' | 'slow' | 'errors' | 'refused'

/** Status colours (always shown with an icon and a label, never colour alone). */
export const SIGNAL: Record<Signal, { color: string; icon: string; label: string; means: string; rank: number }> = {
  refused: { color: '#d03b3b', icon: '✕', label: 'Refused', means: 'nobody answered: no ready Pod, or the connection failed', rank: 4 },
  errors: { color: '#ec835a', icon: '⚠', label: 'Errors', means: `≥ ${ERROR_RATE * 100}% of requests answered with an error`, rank: 3 },
  slow: { color: '#fab219', icon: '◷', label: 'Slow', means: `answers take ≥ ${SLOW_MS} ms on average`, rank: 2 },
  ok: { color: '#0ca30c', icon: '✓', label: 'Healthy', means: 'answered, fast, without errors', rank: 1 },
  idle: { color: '#94a3b8', icon: '○', label: 'Idle', means: 'known dependency, no requests right now', rank: 0 },
}

/** Refused and error shares, from the rates when the backend sends them, else from the old booleans. */
export function rates(f: Flow) {
  return {
    refused: f.refused_rate ?? (f.healthy === false ? 1 : 0),
    error: f.error_rate ?? (f.errors ? 1 : 0),
  }
}

export function signalOf(f: Flow): Signal {
  const r = rates(f)
  if (r.refused >= 0.5) return 'refused'
  if (f.rps <= 0) return 'idle'
  if (r.error + r.refused >= ERROR_RATE) return 'errors'
  if ((f.latency_ms ?? 0) >= SLOW_MS) return 'slow'
  return 'ok'
}

/** Requests-weighted totals of several flows (latency only over the ones that measured it). */
export function combine(flows: Flow[]): Flow & { requests: number } {
  const busy = flows.filter((f) => f.rps > 0)
  const rps = busy.reduce((a, f) => a + f.rps, 0)
  const timed = busy.filter((f) => f.latency_ms != null)
  const timedRps = timed.reduce((a, f) => a + f.rps, 0)
  const weigh = (pick: (f: Flow) => number) => (rps ? busy.reduce((a, f) => a + f.rps * pick(f), 0) / rps : 0)
  return {
    rps,
    requests: rps,
    latency_ms: timedRps ? timed.reduce((a, f) => a + f.rps * f.latency_ms!, 0) / timedRps : null,
    error_rate: weigh((f) => rates(f).error),
    refused_rate: rps ? weigh((f) => rates(f).refused) : Math.max(0, ...flows.map((f) => rates(f).refused)),
  }
}

/**
 * How a service is doing at its job: the requests it receives. A service nobody calls (MiniShop's
 * web front end, whose browser traffic is not logged) is judged by the calls it makes instead.
 */
export function serviceFlow(key: string, flows: Flow[]) {
  const inbound = flows.filter((f) => f.to === key)
  const basis: 'received' | 'sent' = inbound.length ? 'received' : 'sent'
  const flow = combine(basis === 'received' ? inbound : flows.filter((f) => f.from === key))
  return { ...flow, basis, signal: signalOf(flow) }
}

/**
 * The whole city at a glance. Entry flows are where requests come in (from a City Gate, or from a
 * service nobody calls): their rate and latency are what users feel. Errors count every Road.
 */
export function overview(flows: Flow[]) {
  const called = new Set(flows.map((f) => f.to))
  const entry = combine(flows.filter((f) => !called.has(f.from)))
  const all = combine(flows)
  return { rps: entry.rps, latency_ms: entry.latency_ms, failing: entry.error_rate! + entry.refused_rate!,
    allRps: all.rps, allFailing: all.error_rate! + all.refused_rate! }
}

export interface Affected { rank: number; color: string; icon: string; label: string }

/**
 * Why a service needs attention, if it does, most serious first. Pod problems and request problems
 * are separate causes: a service can be Down (no Pod ready) or merely failing its requests.
 */
export function affected(s: { ready: number; want: number; impactedBy?: string | null; signal: Signal; basis?: 'received' | 'sent'; missing?: boolean }): Affected | null {
  if (s.ready === 0) return { rank: 6, color: SIGNAL.refused.color, icon: '✕', label: s.missing ? 'Not deployed' : s.want ? 'Down: no Pod ready' : 'Down: scaled to zero' }
  if (s.signal === 'refused') return { rank: 5, ...pick('refused'), label: s.basis === 'sent' ? 'Its calls are refused' : 'Refusing requests' }
  if (s.signal === 'errors') return { rank: 4, ...pick('errors'), label: s.impactedBy ? `Errors: needs ${s.impactedBy}`
    : s.basis === 'sent' ? 'Errors in the calls it makes' : 'Errors in its answers' }
  if (s.impactedBy) return { rank: 3, ...pick('errors'), label: `Impacted: needs ${s.impactedBy}` }
  if (s.signal === 'slow') return { rank: 2, ...pick('slow'), label: 'Slow answers' }
  if (s.ready < s.want) return { rank: 1, ...pick('slow'), label: `Pods ${s.ready}/${s.want} ready` }
  return null
}
/** Rank at which a Building also gets a light beam; the overview counts those as failed, the rest of the ringed ones as degraded. */
export const SERIOUS = 3

/** Healthy / degraded / failed service counts, cut where the city draws ring vs ring-and-beam. */
export function tally(list: (Affected | null | undefined)[]) {
  return {
    healthy: list.filter((a) => !a).length,
    degraded: list.filter((a) => a && a.rank < SERIOUS).length,
    failed: list.filter((a) => a && a.rank >= SERIOUS).length,
  }
}
const pick = (s: Signal) => ({ color: SIGNAL[s].color, icon: SIGNAL[s].icon })

/** "12.5/s · 85 ms · 2.0% failing", or "idle". */
export function describeFlow(f: Flow) {
  if (f.rps <= 0) return 'idle: no requests right now'
  const r = rates(f)
  const fail = r.error + r.refused
  return `${f.rps < 10 ? f.rps.toFixed(1) : Math.round(f.rps)}/s · ${f.latency_ms == null ? '— ms' : `${Math.round(f.latency_ms)} ms`} · ${(fail * 100).toFixed(fail && fail < 0.1 ? 1 : 0)}% failing`
}
