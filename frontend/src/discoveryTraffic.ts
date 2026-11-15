import type { Edge } from './k8s.ts'

export type DiscoveryActivityPeriod = { source: string | undefined; active: boolean }

/** One visual acknowledgement of an observed active period, not a request counter.
 * Positive rolling counts may repeat, rise or fall without starting another period.
 * Only a measured idle window (or a different viewer source) rearms the cue.
 */
export function startsDiscoveryActivity(state: DiscoveryActivityPeriod, edge: Pick<Edge,'requests'|'rps'>, source: string | undefined) {
  if (state.source !== source) { state.source = source; state.active = false }
  if (!Number.isSafeInteger(edge.requests) || edge.requests! < 0 || !Number.isFinite(edge.rps) || edge.rps < 0) return false
  if (edge.requests === 0 && edge.rps === 0) { state.active = false; return false }
  if (edge.requests! > 0 && edge.rps > 0 && !state.active) { state.active = true; return true }
  return false
}
