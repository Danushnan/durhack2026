import {connectionPurpose, TRAFFIC_WINDOW_SECONDS} from './discoveryActivity.ts'
import type {Edge} from './k8s.ts'
import type {CarAgent} from './traffic.ts'

export interface HoverInfo {
  title: string; lines: string[]; x: number; y: number
  pinnedKey?: string
  pinMode?: 'open'
}

/** A pinned car snapshot ignores incidental road/building pointer-out events. */
export function updateHover(previous: HoverInfo | null, next: HoverInfo | null): HoverInfo | null {
  if (next?.pinnedKey) return previous?.pinnedKey === next.pinnedKey && next.pinMode !== 'open' ? null : next
  return previous?.pinnedKey ? previous : next
}

export function discoveryCarDetails(edge: Edge, car: Pick<CarAgent,'phase'|'fate'>, preview = false, previewRefused = false) {
  const purpose = connectionPurpose(edge)
  const direction = car.phase === 'back' ? `Returning to ${purpose.source}` : car.phase === 'wait' ? `Waiting at ${purpose.destination} for an illustrated error reply` : `Travelling from ${purpose.source} to ${purpose.destination}`
  if (preview) return {
    title: `Demo illustration: ${purpose.source} → ${purpose.destination}`,
    lines: [direction, previewRefused ? 'Synthetic refusal demonstration after an operator readiness check.' : 'Synthetic map preview.',
      'This vehicle is excluded from real activity measurements, Journey evidence and history.'],
  }
  const count = Number.isSafeInteger(edge.requests) ? `${edge.requests} instrumented completions in the rolling ${TRAFFIC_WINDOW_SECONDS}s window` : 'Completion count unavailable'
  const share = (value: number | undefined) => value === undefined ? 'unavailable' : `${(value*100).toFixed(1)}%`
  return {
    title: `${purpose.source} → ${purpose.destination}`,
    lines: [
      `${purpose.kind} · ${direction}`,
      `Typical purpose: ${purpose.description}`,
      `${count} · ${edge.rps.toFixed(2)}/s`,
      edge.latency_ms == null ? 'Average timed duration unavailable' : `Route average timed duration: ${edge.latency_ms.toFixed(1)} ms`,
      `Non-success/error reply share: ${share(edge.error_rate)} · Failed communication share: ${share(edge.refused_rate)}`,
      car.fate === 'refused' ? 'This return illustrates failed communication without an HTTP answer; it does not diagnose a pod outage.'
        : car.fate === 'error' ? 'This vehicle illustrates an error reply. Business declines such as HTTP 402 do not establish a pod outage.'
        : 'This vehicle illustrates aggregate activity; its individual outcome is not traced.',
      'Captured route snapshot, not one request. Vehicle speed and travel time are illustrative.',
    ],
  }
}
