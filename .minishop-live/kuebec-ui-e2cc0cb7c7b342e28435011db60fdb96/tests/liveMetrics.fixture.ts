import type { LiveMetricsSnapshot, LiveServiceMetrics } from '../src/liveMetrics.ts'
import type { K8sObject } from '../src/k8s.ts'

export const paymentDeployment: K8sObject = { kind: 'Deployment', metadata: {
  name: 'payment-api', namespace: 'minishop', uid: 'payment-deployment' }, spec: { replicas: 3 }, status: { readyReplicas: 3 } }

export function snapshot(overrides: Partial<LiveServiceMetrics> = {}): LiveMetricsSnapshot {
  const observed_at = '2026-11-14T21:00:10+00:00'
  return {
    type: 'SERVICE_METRICS', schema_version: 1, mode: 'live', application: 'minishop',
    source_id: 'kubernetes:kind-minishop:minishop', context: 'kind-minishop', observed_at,
    window: { start: '2026-11-14T21:00:00+00:00', end: observed_at, seconds: 10 },
    source: { status: 'connected', last_resource_refresh_at: observed_at, last_log_poll_at: observed_at,
      last_application_event_at: observed_at, rejected_records: 0, error: null },
    services: ['minishop-web', 'product-api', 'cart-api', 'checkout-api', 'payment-api', 'postgres', 'redis'].map((name) => {
      const unsupported = name === 'postgres' || name === 'redis'
      const row: LiveServiceMetrics = {
        service: `minishop/${name}`, namespace: 'minishop', deployment_uid: name === 'payment-api' ? 'payment-deployment' : `${name}-deployment`,
        measurement_kind: unsupported ? 'unsupported' : name === 'minishop-web' ? 'proxy_access' : 'http_server',
        request_count: unsupported ? null : 4, requests_per_second: unsupported ? null : 0.4,
        avg_latency_ms: unsupported ? null : 100, p95_latency_ms: unsupported ? null : 150,
        error_count: unsupported ? null : 0, error_rate: unsupported ? null : 0,
        business_rejection_count: unsupported ? null : 0, business_decline_count: unsupported ? null : 0,
        checkout: name === 'checkout-api' ? { attempt_count: 2, success_count: 2, business_rejection_count: 0, failure_count: 0, success_rate: 1 } : null,
        desired_replicas: 3, ready_replicas: 3, infrastructure_status: 'healthy',
        application_status: unsupported ? 'not_applicable' : 'healthy', availability: unsupported ? 'unsupported' : 'active',
        window_complete: !unsupported, last_log_poll_at: observed_at, last_event_at: unsupported ? null : observed_at,
      }
      return name === 'payment-api' ? { ...row, ...overrides } : row
    }),
  }
}
