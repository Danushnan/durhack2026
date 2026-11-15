import type { ClusterState, Edge } from './k8s.ts'

// backend/live.py summarizes TRAFFIC over the last five seconds.
const TRAFFIC_WINDOW_MS = 5_000

export const roadKey = ({ from, to }: Pick<Edge, 'from' | 'to'>) => `${from}>${to}`

export interface RoadDiscovery {
  source: string
  resetAt: number
  firstSnapshotAt?: number
  armed: boolean
  roads: ReadonlySet<string>
}

export function startDiscovery(source: string, resetAt: number): RoadDiscovery {
  return { source, resetAt, armed: false, roads: new Set() }
}

export function discoveryReady(cluster: ClusterState) {
  return cluster.connected && !cluster.awaitingSnapshot && cluster.stale === false &&
    !cluster.metricsStale && !cluster.metricsError && cluster.metrics?.source.status === 'connected' &&
    cluster.metrics.context === cluster.context
}

export function updateDiscovery(discovery: RoadDiscovery | null, cluster: ClusterState): RoadDiscovery | null {
  if (!discovery) return null
  const metrics = cluster.metrics
  if (metrics?.source_id !== discovery.source || metrics.context !== cluster.context) return null
  if (!discoveryReady(cluster) || cluster.metricsReceivedAt === undefined || cluster.metricsReceivedAt <= discovery.resetAt) return discovery

  // Anchor to the first usable server snapshot after reset. Server and browser clocks
  // need not agree. Require elapsed time on both before trusting a full new window.
  const observedAt = Date.parse(metrics.observed_at)
  const firstSnapshotAt = Math.min(discovery.firstSnapshotAt ?? observedAt, observedAt)
  const armed = discovery.armed ||
    (observedAt - firstSnapshotAt > TRAFFIC_WINDOW_MS && cluster.metricsReceivedAt - discovery.resetAt > TRAFFIC_WINDOW_MS)
  let added: Set<string> | undefined
  if (armed && cluster.trafficSnapshotAt === metrics.observed_at) {
    const services = new Map(metrics.services.map((service) => [service.service, service]))
    for (const edge of cluster.edges) {
      const caller = services.get(edge.from)
      const callee = services.get(edge.to)
      if (edge.from === edge.to || !caller?.deployment_uid || !callee?.deployment_uid ||
        !caller.window_complete || edge.requests === undefined || !Number.isSafeInteger(edge.requests) ||
        edge.requests <= 0 || edge.rps <= 0) continue
      const key = roadKey(edge)
      if (!discovery.roads.has(key)) (added ??= new Set(discovery.roads)).add(key)
    }
  }
  return firstSnapshotAt === discovery.firstSnapshotAt && armed === discovery.armed && !added
    ? discovery : { ...discovery, firstSnapshotAt, armed, roads: added ?? discovery.roads }
}

export function roadVisible(edge: Pick<Edge, 'from' | 'to'>, discovered?: ReadonlySet<string>) {
  return discovered === undefined || discovered.has(roadKey(edge))
}
