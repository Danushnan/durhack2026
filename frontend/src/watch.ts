import { demoCityView, isMiniShopComponent } from './miniShopView.ts'
import type { ClusterState, Edge, K8sObject } from './k8s.ts'
import { queueDemoPackets } from './demoPackets.ts'
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
export function reduceWatchMessage(previous: ClusterState, data: unknown, receivedAt = Date.now(), packetSeed = receivedAt): ClusterState {
  let batch: unknown
  try { batch = typeof data === 'string' ? JSON.parse(data) : data } catch { return { ...previous, metricsError: 'Invalid WebSocket JSON; retaining last data' } }
  if (!Array.isArray(batch)) return { ...previous, metricsError: 'Expected an event array; retaining last data' }
  let state: ClusterState = { ...previous, trafficSnapshotAt: undefined }
  let objects = previous.objects
  let receivedSource = false
  let receivedTraffic = false
  let receivedMetrics = false
  const packetRandom = () => {
    packetSeed = (Math.imul(packetSeed, 1664525) + 1013904223) >>> 0
    return packetSeed / 2 ** 32
  }
  const writeObjects = () => { if (objects === previous.objects) objects = { ...objects } }
  for (const event of batch) {
    if (!record(event)) continue
    switch (event.type) {
      case 'SOURCE': {
        if (event.context !== null && typeof event.context !== 'string') break
        receivedSource = true
        const context = event.context as string | null
        const changed = state.context !== context
        if (state.awaitingSnapshot || changed) {
          objects = {}; state.edges = []; state.stale = undefined
          state.awaitingSnapshot = false
          state.demoPackets = undefined
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
        receivedMetrics = true
        break
      case 'DEMO_PACKETS': {
        if (typeof event.count !== 'number' || !Number.isInteger(event.count) || event.count < 1 || event.count > 100 ||
          typeof event.cross_district !== 'boolean') break
        const demo = state.demoPackets ?? { routes: {}, last: {}, reset: 0 }
        const candidates = Object.values(event.ambient === true ? demoCityView({ ...state, objects }).objects : objects)
        const miniShopOnly = event.ambient !== true && typeof state.context === 'string' && candidates.some(isMiniShopComponent)
        const workloads = new Set(candidates.flatMap(object => {
          const {kind, metadata} = object
          return (kind === 'Deployment' || kind === 'StatefulSet') && metadata.namespace && !metadata.deletionTimestamp && (!miniShopOnly || isMiniShopComponent(object))
            ? [`${metadata.namespace}/${metadata.name}`] : []
        }))
        state.demoPackets = queueDemoPackets(demo, [...workloads].sort(), event.count, event.cross_district, packetRandom)
        break
      }
      case 'DEMO_PACKETS_RESET':
        state.demoPackets = { routes: {}, last: {}, reset: (state.demoPackets?.reset ?? 0) + 1 }
        break
      case 'DEMO_REFUSAL': {
        if (typeof state.context !== 'string' || event.context !== state.context ||
          typeof event.source !== 'string' || typeof event.target !== 'string' || event.source === event.target) break
        const demo = state.demoPackets ?? { routes: {}, last: {}, reset: 0 }
        const key = `refused:${event.source}>${event.target}`
        state.demoPackets = { ...demo, routes: { ...demo.routes, [key]: {
          call: { from: event.source, to: event.target },
          count: (demo.routes[key]?.count ?? 0) + 1,
          refused: true,
        } } }
        break
      }
      case 'TRAFFIC':
        if (Array.isArray(event.edges) && event.edges.every(edgeGuard)) {
          state.edges = event.edges
          receivedTraffic = true
        }
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
  // An initial/reconnect snapshot can replay the previous traffic window.
  if (receivedTraffic && receivedMetrics && !receivedSource) state.trafficSnapshotAt = state.metrics?.observed_at
  return { ...state, objects }
}
