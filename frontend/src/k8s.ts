import { useEffect, useState } from 'react'

// Trimmed Kubernetes object shapes, as streamed by the backend's watch.
export interface K8sObject {
  kind: string
  deploymentUid?: string
  metadata: {
    name: string
    namespace?: string
    uid: string
    labels?: Record<string, string>
    annotations?: Record<string, string>
    creationTimestamp?: string
    deletionTimestamp?: string
  }
  spec?: any
  status?: any
  // Event-only fields
  involvedObject?: { kind: string; namespace: string; name: string }
  reason?: string
  message?: string
  type?: string
  lastTimestamp?: string
}

export interface Edge { from: string; to: string; rps: number; healthy: boolean }

type WatchEvent =
  | { type: 'ADDED' | 'MODIFIED' | 'DELETED'; object: K8sObject }
  | { type: 'SOURCE'; context: string }
  | { type: 'HEALTH'; stale: boolean; lastRefresh: number | null }
  | { type: 'TRAFFIC'; edges: Edge[] }

export interface ClusterState {
  objects: Record<string, K8sObject> // by uid
  edges: Edge[]
  connected: boolean
  context?: string
  stale?: boolean
}

export const nodeReady = (node: K8sObject) =>
  node.status?.conditions?.some((condition: { type: string; status: string }) =>
    condition.type === 'Ready' && condition.status === 'True') ?? false

export const belongsTo = (pod: K8sObject, dep: K8sObject) =>
  pod.metadata.namespace === dep.metadata.namespace &&
  (pod.deploymentUid ? pod.deploymentUid === dep.metadata.uid : pod.metadata.labels?.app === dep.metadata.name)

export const keyOf = (o: { metadata: { namespace?: string; name: string } }) =>
  `${o.metadata.namespace}/${o.metadata.name}`

/** kubectl-style display status, derived from real Pod phase + container state. */
export type PodStatus = 'Running' | 'ContainerCreating' | 'Pending' | 'CrashLoopBackOff' | 'Terminating' | 'NotReady'

export function podStatus(pod: K8sObject): PodStatus {
  if (pod.metadata.deletionTimestamp) return 'Terminating'
  const c = pod.status?.containerStatuses?.[0]
  const waiting = c?.state?.waiting?.reason
  if (waiting === 'CrashLoopBackOff' || waiting === 'ContainerCreating') return waiting
  if (pod.status?.phase === 'Pending') return 'Pending'
  return c?.ready ? 'Running' : 'NotReady'
}

export const STATUS_COLOR: Record<PodStatus, string> = {
  Running: '#22d3ee',
  ContainerCreating: '#facc15',
  Pending: '#64748b',
  CrashLoopBackOff: '#ef4444',
  Terminating: '#f97316',
  NotReady: '#eab308',
}

/** Plain-English wording for each status, shown with the Kubernetes term underneath. */
export const FRIENDLY: Record<PodStatus, string> = {
  Running: 'Working',
  ContainerCreating: 'Starting up',
  Pending: 'Waiting for space',
  CrashLoopBackOff: 'Crashing',
  Terminating: 'Shutting down',
  NotReady: 'Not ready yet',
}

export function describePod(pod: K8sObject): string {
  const s = podStatus(pod)
  const wait = /back-off (\d+)s/.exec(pod.status?.containerStatuses?.[0]?.state?.waiting?.message ?? '')
  return s === 'CrashLoopBackOff' && wait ? `Crashing, next retry waits ${wait[1]}s` : FRIENDLY[s]
}

export type Health = 'healthy' | 'degraded' | 'down'

export function deploymentHealth(dep: K8sObject): Health {
  const ready = dep.status?.readyReplicas ?? 0, want = dep.spec?.replicas ?? 0
  if (want > 0 && ready === 0) return 'down'
  return ready >= want ? 'healthy' : 'degraded'
}

export function describeDeployment(dep: K8sObject): string {
  const ready = dep.status?.readyReplicas ?? 0, want = dep.spec?.replicas ?? 0
  if (want === 0) return 'Closed: scaled to zero Units'
  if (ready === 0) return `Down: none of ${want} Units working`
  if (ready < want) return `${ready} of ${want} Units working`
  return `All ${want} Units working`
}

export const HEALTH_COLOR: Record<Health, string> = { healthy: '#22d3ee', degraded: '#f59e0b', down: '#ef4444' }

export const NODE_COLORS = ['#38bdf8', '#c084fc', '#4ade80', '#fb7185', '#fbbf24']

export function useCluster(): ClusterState {
  const [state, setState] = useState<ClusterState>({ objects: {}, edges: [], connected: false })

  useEffect(() => {
    let ws: WebSocket | undefined
    let retry: number
    let closed = false
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`)
      ws.onopen = () => setState({ objects: {}, edges: [], connected: true }) // server resends everything
      ws.onmessage = (msg) => {
        const batch: WatchEvent[] = JSON.parse(msg.data)
        setState((s) => {
          const objects = { ...s.objects }
          let edges = s.edges
          let { context, stale } = s
          for (const ev of batch) {
            if (ev.type === 'SOURCE') context = ev.context
            else if (ev.type === 'HEALTH') stale = ev.stale
            else if (ev.type === 'TRAFFIC') edges = ev.edges
            else if (ev.type === 'DELETED') delete objects[ev.object.metadata.uid]
            else objects[ev.object.metadata.uid] = ev.object
          }
          return { objects, edges, context, stale, connected: true }
        })
      }
      ws.onclose = () => {
        if (closed) return
        setState((s) => ({ ...s, connected: false }))
        retry = window.setTimeout(connect, 1000)
      }
    }
    retry = window.setTimeout(connect, 0)
    return () => {
      closed = true
      clearTimeout(retry)
      ws?.close()
    }
  }, [])

  return state
}

async function call(method: string, path: string, body?: unknown) {
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) throw new Error(`Request failed (HTTP ${res.status})`)
  } catch (error) {
    window.alert(error instanceof Error ? error.message : 'Request failed')
  }
}

export const api = {
  demolish: (ns: string, pod: string) => call('DELETE', `/namespaces/${ns}/pods/${pod}`),
  scale: (ns: string, dep: string, replicas: number) =>
    call('PUT', `/namespaces/${ns}/deployments/${dep}/scale`, { replicas }),
  sabotage: (ns: string, dep: string, enabled: boolean) =>
    call('PUT', `/namespaces/${ns}/deployments/${dep}/sabotage`, { enabled }),
  outage: (node: string, enabled: boolean) => call('PUT', `/nodes/${node}/outage`, { enabled }),
}
