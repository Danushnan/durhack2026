import type { Affected } from './health.ts'
import type { ClusterState, K8sObject } from './k8s.ts'

export type InfrastructureStatus = 'healthy' | 'degraded' | 'unavailable' | 'scaled_down' | 'unknown'
export type ApplicationStatus = 'healthy' | 'degraded' | 'unavailable' | 'unknown' | 'not_applicable'
export type Availability = 'active' | 'idle' | 'partial' | 'stale' | 'unavailable' | 'unsupported'
export interface CheckoutMetrics {
  attempt_count: number; success_count: number; business_rejection_count: number; failure_count: number
  success_rate: number | null
}
export interface LiveServiceMetrics {
  service: string; namespace: string; deployment_uid: string | null
  measurement_kind: 'http_server' | 'proxy_access' | 'unsupported'
  request_count: number | null; requests_per_second: number | null
  avg_latency_ms: number | null; p95_latency_ms: number | null
  error_count: number | null; error_rate: number | null
  business_rejection_count: number | null; business_decline_count: number | null
  checkout: CheckoutMetrics | null
  desired_replicas: number | null; ready_replicas: number | null
  infrastructure_status: InfrastructureStatus; application_status: ApplicationStatus
  availability: Availability; window_complete: boolean
  last_log_poll_at: string | null; last_event_at: string | null
}
export interface LiveMetricsSnapshot {
  type: 'SERVICE_METRICS'; schema_version: 1; mode: 'live'; application: 'minishop'
  source_id: string; context: string; observed_at: string
  window: { start: string; end: string; seconds: number }
  source: {
    status: 'connected' | 'degraded' | 'disconnected' | 'unavailable'
    last_resource_refresh_at: string | null; last_log_poll_at: string | null
    last_application_event_at: string | null; rejected_records: number; error: string | null
  }
  services: LiveServiceMetrics[]
}

// Small schema guards keep the socket trust boundary independent of React and Three.js.
type Guard = (value: unknown) => boolean
type Shape<T> = { [K in keyof T]-?: Guard }
export const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str: Guard = (v) => typeof v === 'string'
const bool: Guard = (v) => typeof v === 'boolean'
const nonnegative: Guard = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0
const integer: Guard = (v) => nonnegative(v) && Number.isInteger(v)
const fraction: Guard = (v) => nonnegative(v) && (v as number) <= 1
const date: Guard = (v) => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) && Number.isFinite(Date.parse(v))
const nullable = (check: Guard): Guard => (v) => v === null || check(v)
const oneOf = (...values: unknown[]): Guard => (v) => values.includes(v)
const shape = <T>(fields: Shape<T>): Guard => (v) => record(v) && Object.keys(v).length === Object.keys(fields).length &&
  Object.entries<Guard>(fields).every(([key, check]) => Object.hasOwn(v, key) && check(v[key]))
const checkoutGuard = shape<CheckoutMetrics>({ attempt_count: integer, success_count: integer,
  business_rejection_count: integer, failure_count: integer, success_rate: nullable(fraction) })
const serviceGuard = shape<LiveServiceMetrics>({
  service: (v) => typeof v === 'string' && /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(v),
  namespace: str, deployment_uid: nullable(str), measurement_kind: oneOf('http_server', 'proxy_access', 'unsupported'),
  request_count: nullable(integer), requests_per_second: nullable(nonnegative), avg_latency_ms: nullable(nonnegative),
  p95_latency_ms: nullable(nonnegative), error_count: nullable(integer), error_rate: nullable(fraction),
  business_rejection_count: nullable(integer), business_decline_count: nullable(integer), checkout: nullable(checkoutGuard),
  desired_replicas: nullable(integer), ready_replicas: nullable(integer),
  infrastructure_status: oneOf('healthy', 'degraded', 'unavailable', 'scaled_down', 'unknown'),
  application_status: oneOf('healthy', 'degraded', 'unavailable', 'unknown', 'not_applicable'),
  availability: oneOf('active', 'idle', 'partial', 'stale', 'unavailable', 'unsupported'), window_complete: bool,
  last_log_poll_at: nullable(date), last_event_at: nullable(date),
})
const snapshotGuard = shape<LiveMetricsSnapshot>({
  type: oneOf('SERVICE_METRICS'), schema_version: oneOf(1), mode: oneOf('live'), application: oneOf('minishop'),
  source_id: str, context: str, observed_at: date,
  window: shape<LiveMetricsSnapshot['window']>({ start: date, end: date, seconds: (v) => nonnegative(v) && (v as number) > 0 }),
  source: shape<LiveMetricsSnapshot['source']>({ status: oneOf('connected', 'degraded', 'disconnected', 'unavailable'),
    last_resource_refresh_at: nullable(date), last_log_poll_at: nullable(date), last_application_event_at: nullable(date),
    rejected_records: integer, error: nullable(str) }),
  services: (v) => Array.isArray(v) && v.length === 7 && v.every(serviceGuard),
})

export function isLiveMetrics(v: unknown): v is LiveMetricsSnapshot {
  if (!snapshotGuard(v)) return false
  const s = v as LiveMetricsSnapshot
  const names = ['minishop-web', 'product-api', 'cart-api', 'checkout-api', 'payment-api', 'postgres', 'redis']
  const namespaces = new Set(s.services.map((r) => r.namespace))
  return namespaces.size === 1 && new Set(s.services.map((r) => r.service)).size === 7 &&
    s.services.every((r) => r.service.startsWith(`${r.namespace}/`) && names.includes(r.service.split('/')[1])) &&
    s.source_id === `kubernetes:${s.context}:${s.services[0].namespace}` && Date.parse(s.window.start) < Date.parse(s.window.end)
}

export const label = (value: string) => value.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())
export const numberText = (n: number | null | undefined, digits = 0) => n == null ? '—' : n.toFixed(digits)
export const latencyText = (n: number | null | undefined) => n == null ? '—' : `${Math.round(n)} ms`
export const rateText = (n: number | null | undefined) => n == null ? '—' : `${(n * 100).toFixed(1)}%`
export const LIVE_COLOR = { healthy: '#0ca30c', degraded: '#fab219', unavailable: '#d03b3b', unknown: '#94a3b8', not_applicable: '#94a3b8' }
// Transport silence is distinct from the backend's configurable log freshness policy.
export const SNAPSHOT_SILENCE_MS = 10_000

export interface LiveServiceView {
  metrics?: LiveServiceMetrics
  application: ApplicationStatus
  infrastructure: InfrastructureStatus
  availability: Availability | 'loading' | 'disconnected'
  current: boolean
  color: string
  affected: Affected | null
}

export function liveServiceView(dep: K8sObject, cluster: ClusterState): LiveServiceView | undefined {
  if (typeof cluster.context !== 'string') return undefined
  const key = `${dep.metadata.namespace}/${dep.metadata.name}`
  const candidate = cluster.metrics?.services.find((r) => r.service === key && r.namespace === dep.metadata.namespace)
  const metrics = candidate && (candidate.deployment_uid === null || candidate.deployment_uid === dep.metadata.uid) ? candidate : undefined
  const current = !!metrics && cluster.connected && !cluster.awaitingSnapshot && !cluster.metricsStale && !cluster.metricsError
  const application = metrics?.measurement_kind === 'unsupported' ? 'not_applicable'
    : current && (metrics!.application_status !== 'healthy' || metrics!.availability === 'active' && metrics!.window_complete)
      ? metrics!.application_status : 'unknown'
  const ready = dep.status?.readyReplicas ?? 0, want = dep.spec?.replicas ?? 0
  const fallback: InfrastructureStatus = want === 0 ? 'scaled_down' : ready === 0 ? 'unavailable' : ready < want ? 'degraded' : 'healthy'
  const infrastructure = !cluster.connected || cluster.awaitingSnapshot || cluster.stale ? 'unknown' : current ? metrics!.infrastructure_status : fallback
  const availability = !cluster.connected ? 'disconnected' : !metrics ? 'loading' : !current ? 'stale' : metrics.availability
  let affected: Affected | null = null
  if (infrastructure === 'unavailable') affected = { rank: 6, color: LIVE_COLOR.unavailable, icon: '✕', label: 'Infrastructure unavailable' }
  else if (infrastructure === 'scaled_down') affected = { rank: 5, color: LIVE_COLOR.unknown, icon: '○', label: 'Scaled down' }
  else if (application === 'degraded') affected = { rank: 4, color: LIVE_COLOR.degraded, icon: '⚠', label: 'Application degraded' }
  else if (application === 'unavailable') affected = { rank: 4, color: LIVE_COLOR.unavailable, icon: '✕', label: 'Application unavailable' }
  else if (infrastructure === 'degraded') affected = { rank: 2, color: LIVE_COLOR.degraded, icon: '⚠', label: 'Infrastructure degraded' }
  return { metrics, application, infrastructure, availability, current, affected,
    color: application === 'not_applicable' ? infrastructure === 'healthy' ? '#22d3ee' : infrastructure === 'unavailable' ? LIVE_COLOR.unavailable : LIVE_COLOR.unknown : LIVE_COLOR[application] }
}

/** Snapshot totals count incoming service completions, not users, orders or journeys. */
export function summarizeLive(snapshot: LiveMetricsSnapshot) {
  const supported = snapshot.services.filter((r) => r.measurement_kind !== 'unsupported')
  const measured = supported.filter((r) => r.request_count !== null)
  const sum = (pick: (r: LiveServiceMetrics) => number | null) => measured.length ? measured.reduce((n, r) => n + (pick(r) ?? 0), 0) : null
  const requests = sum((r) => r.request_count)
  const errors = sum((r) => r.error_count)
  const timed = measured.filter((r) => r.avg_latency_ms !== null && r.request_count! > 0)
  const timedCount = timed.reduce((n, r) => n + r.request_count!, 0)
  const p95s = measured.flatMap((r) => r.p95_latency_ms === null ? [] : [r.p95_latency_ms])
  return { requests, rps: sum((r) => r.requests_per_second), errors,
    errorRate: requests && errors !== null ? errors / requests : null,
    average: timedCount ? timed.reduce((n, r) => n + r.avg_latency_ms! * (r.request_count! / timedCount), 0) : null,
    highestP95: p95s.length ? Math.max(...p95s) : null,
    coverage: measured.length, supported: supported.length,
    complete: supported.every((r) => r.window_complete),
  }
}

/** Collapse only trustworthy healthy states; idle/unknown/stale remain explicit. */
export function compactLiveTag(view: LiveServiceView, selected: boolean, changing = false): boolean {
  return !selected && !changing && view.current && !view.affected && view.infrastructure === 'healthy' &&
    (view.application === 'healthy' && view.availability === 'active' ||
     view.application === 'not_applicable' && view.availability === 'unsupported')
}
