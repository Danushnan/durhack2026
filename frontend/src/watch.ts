import type { ClusterState, Edge, K8sObject } from './k8s.ts'
import { isLiveMetrics, record, SNAPSHOT_SILENCE_MS } from './liveMetrics.ts'

export const initialClusterState = (): ClusterState => ({ objects: {}, edges: [], connected: false })
export function checkSnapshotFreshness(state: ClusterState, now = Date.now()): ClusterState {
  const metricsStale = state.metricsReceivedAt !== undefined && now - state.metricsReceivedAt > SNAPSHOT_SILENCE_MS
  return metricsStale === !!state.metricsStale ? state : { ...state, metricsStale }
}
const objectGuard = (o: unknown): o is K8sObject => record(o) && typeof o.kind === 'string' && record(o.metadata) &&
  typeof o.metadata.uid === 'string' && typeof o.metadata.name === 'string'
const edgeGuard = (e: unknown): e is Edge => record(e) && typeof e.from === 'string' && typeof e.to === 'string' &&
  typeof e.rps === 'number' && Number.isFinite(e.rps) && e.rps >= 0 && typeof e.healthy === 'boolean' &&
  ['error_rate', 'refused_rate'].every((key) => e[key] === undefined || typeof e[key] === 'number' && Number.isFinite(e[key]) && e[key] >= 0 && e[key] <= 1) &&
  (e.latency_ms == null || typeof e.latency_ms === 'number' && Number.isFinite(e.latency_ms) && e.latency_ms >= 0)

/** All resource and metric snapshots are reconciled in one React update. Never accumulate metrics. */
export function reduceWatchMessage(previous: ClusterState, data: unknown, receivedAt = Date.now()): ClusterState {
  let batch: unknown
  try { batch = typeof data === 'string' ? JSON.parse(data) : data } catch { return { ...previous, metricsError: 'Invalid WebSocket JSON; retaining last data' } }
  if (!Array.isArray(batch)) return { ...previous, metricsError: 'Expected an event array; retaining last data' }
  let state = { ...previous }
  let objects = previous.objects
  const writeObjects = () => { if (objects === previous.objects) objects = { ...objects } }
  for (const event of batch) {
    if (!record(event)) continue
    switch (event.type) {
      case 'SOURCE': {
        if (event.context !== null && typeof event.context !== 'string') break
        const context = event.context as string | null
        const changed = state.context !== context
        if (state.awaitingSnapshot || changed) {
          objects = {}; state.edges = []; state.stale = undefined
          state.awaitingSnapshot = false
        }
        if (changed || context === null) {
          state.metrics = undefined; state.metricsReceivedAt = undefined; state.metricsStale = false; state.metricsError = undefined
        }
        state.context = context
        break
      }
      case 'SERVICE_METRICS':
        if (!isLiveMetrics(event) || event.context !== state.context) {
          state.metricsError = 'Invalid or mismatched MiniShop snapshot; retaining last data'
          break
        }
        // Reconnect's initial snapshot may come from a restarted backend with a different clock.
        if (!previous.awaitingSnapshot && state.metrics?.source_id === event.source_id && Date.parse(event.observed_at) < Date.parse(state.metrics.observed_at)) break
        state.metrics = event; state.metricsReceivedAt = receivedAt; state.metricsStale = false; state.metricsError = undefined
        break
      case 'TRAFFIC':
        if (Array.isArray(event.edges) && event.edges.every(edgeGuard)) state.edges = event.edges
        break
      case 'HEALTH':
        if (typeof event.stale === 'boolean' && (event.lastRefresh === null || typeof event.lastRefresh === 'number' && Number.isFinite(event.lastRefresh))) {
          state.stale = event.stale; state.lastRefresh = event.lastRefresh as number | null
        }
        break
      case 'ADDED': case 'MODIFIED': case 'DELETED':
        if (!objectGuard(event.object)) break
        writeObjects()
        if (event.type === 'DELETED') delete objects[event.object.metadata.uid]
        else objects[event.object.metadata.uid] = event.object
        break
      default: break // Future events must never be interpreted as Kubernetes objects.
    }
  }
  return { ...state, objects }
}
