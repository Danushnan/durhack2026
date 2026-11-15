import { rates, type Flow } from './health.ts'

/** Readiness is resource health, never evidence of a particular request outcome. */
export function trafficOutcomeRates(edge: Flow, preview: boolean, previewRefused = false) {
  return preview ? { refused: previewRefused ? 1 : 0, error: 0 } : rates(edge)
}
