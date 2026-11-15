import { useEffect, useState } from 'react'
import type { DemoPackets } from './demoPackets'
import type { LiveMetricsSnapshot } from './liveMetrics'
import { checkSnapshotFreshness, initialClusterState, reduceWatchMessage } from './watch'

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
    ownerReferences?: { kind: string; name: string; uid: string; controller?: boolean }[]
  }
  spec?: any
  status?: any
  // Event-only fields
  involvedObject?: { kind: string; namespace: string; name: string }
  reason?: string
  message?: string
  type?: string
  lastTimestamp?: string
  reportingComponent?: string // which part of Kubernetes reported the event
  reportingInstance?: string  // e.g. the Node, for kubelet events
  source?: { component?: string; host?: string } // older event fields, still common on real clusters
}

/** healthy: the target has ready Pods to answer. errors: it answers, but with errors, because something it needs is down. */
export interface Edge {
  from: string; to: string; rps: number; healthy: boolean; errors?: boolean
  declared?: boolean // live: an architecture manifest or env var declares this call (absent in the simulator: all are)
  recent_errors?: { at: number; status: number; outcome: 'error' | 'refused'; detail: string }[] // live: newest last
  requests?: number; latency_ms?: number | null; error_rate?: number; refused_rate?: number
}

/** Live: a component an architecture manifest lists but the cluster does not run. */
export const notDeployed = (dep: K8sObject) => dep.metadata.annotations?.['kubeverse.io/not-deployed'] === 'true'

export interface ClusterState {
  objects: Record<string, K8sObject> // by uid
  edges: Edge[]
  demoPackets?: DemoPackets
  connected: boolean
  context?: string | null // kubectl context when watching a real cluster (read-only); null/absent for the simulator
  stale?: boolean          // live mode: the last refresh from the cluster failed
  lastRefresh?: number | null
  awaitingSnapshot?: boolean
  metrics?: LiveMetricsSnapshot
  metricsReceivedAt?: number
  trafficSnapshotAt?: string // server time of a TRAFFIC update paired with an accepted metrics snapshot
  metricsStale?: boolean
  metricsError?: string
}

/** Deployments and StatefulSets are both drawn as Buildings. */
export const isWorkload = (o: K8sObject) => o.kind === 'Deployment' || o.kind === 'StatefulSet'

export const nodeReady = (node: K8sObject) =>
  node.status?.conditions?.some((condition: { type: string; status: string }) =>
    condition.type === 'Ready' && condition.status === 'True') ?? false

/** A Pod belongs to a workload by owner (live clusters strip labels) or by its app label (simulator). */
export const belongsTo = (pod: K8sObject, dep: K8sObject) =>
  pod.metadata.namespace === dep.metadata.namespace &&
  (pod.deploymentUid ? pod.deploymentUid === dep.metadata.uid : pod.metadata.labels?.app === dep.metadata.name)

export const podsOf = (w: K8sObject, pods: K8sObject[]) => pods.filter((p) => belongsTo(p, w))

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
  NotReady: 'Warming up (not in rotation)',
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
  if (notDeployed(dep)) return 'Not deployed: in architecture.json, missing from the cluster'
  if (want === 0) return 'Closed: scaled to zero Units'
  if (ready === 0) return `Down: none of ${want} Units working`
  if (ready < want) return `${ready} of ${want} Units working`
  return `All ${want} Units working`
}

/** Where a Deployment's rollout stands: which version it wants, and how far along it is. */
export interface Rollout {
  version: string            // the version Kubernetes is rolling towards
  previous?: string          // what `kubectl rollout undo` would go back to
  rolling: boolean           // old-version Pods still around, or new ones not all ready
  stalled: boolean           // progress deadline exceeded: the new version never became ready
  buggy: boolean
  byVersion: Record<string, { ready: number; total: number }>
}

export function rolloutOf(dep: K8sObject, pods: K8sObject[]): Rollout {
  const version: string = dep.spec?.template?.metadata?.labels?.version ?? 'v1'
  const progressing = dep.status?.conditions?.find((c: { type: string }) => c.type === 'Progressing')
  const byVersion: Rollout['byVersion'] = {}
  for (const p of pods) {
    if (p.metadata.deletionTimestamp) continue
    const v = p.metadata.labels?.version ?? 'v1'
    byVersion[v] ??= { ready: 0, total: 0 }
    byVersion[v].total++
    if (p.status?.containerStatuses?.[0]?.ready) byVersion[v].ready++
  }
  return {
    version,
    previous: dep.metadata.annotations?.['kubeverse.io/previous-version'],
    rolling: dep.kind === 'Deployment' && progressing !== undefined && progressing.reason !== 'NewReplicaSetAvailable',
    stalled: progressing?.reason === 'ProgressDeadlineExceeded',
    buggy: dep.metadata.annotations?.['kubeverse.io/buggy-release'] === 'true',
    byVersion,
  }
}

/** One colour per version, so a rollout is visible as Units changing colour. */
const VERSION_COLORS = ['#f8fafc', '#c4b5fd', '#f9a8d4', '#fde68a', '#99f6e4', '#fdba74']
export const versionColor = (v: string) => VERSION_COLORS[(Number(v.replace(/\D/g, '')) - 1) % VERSION_COLORS.length] ?? VERSION_COLORS[0]

export const HEALTH_COLOR: Record<Health, string> = { healthy: '#22d3ee', degraded: '#f59e0b', down: '#ef4444' }

export const NODE_COLORS = ['#38bdf8', '#c084fc', '#4ade80', '#fb7185', '#fbbf24']

export function useCluster(): ClusterState {
  const [state, setState] = useState<ClusterState>(initialClusterState)

  useEffect(() => {
    let ws: WebSocket | undefined
    let retry: number
    let closed = false
    const connect = () => {
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?telemetry=1`)
      ws = socket
      socket.onopen = () => { if (!closed && ws === socket) setState((s) => ({ ...s, connected: true, awaitingSnapshot: true })) }
      socket.onmessage = (msg) => {
        if (!closed && ws === socket) {
          const receivedAt = Date.now(), seed = Math.floor(Math.random() * 2 ** 32)
          setState((s) => reduceWatchMessage(s, msg.data, receivedAt, seed))
        }
      }
      socket.onerror = () => socket.close()
      socket.onclose = () => {
        if (closed || ws !== socket) return
        setState((s) => ({ ...s, connected: false, demoPackets: undefined }))
        retry = window.setTimeout(connect, 1000)
      }
    }
    retry = window.setTimeout(connect, 0)
    const watchdog = window.setInterval(() => setState(checkSnapshotFreshness), 1000)
    return () => {
      closed = true
      clearTimeout(retry)
      clearInterval(watchdog)
      ws?.close()
    }
  }, [])

  return state
}

/** Failed actions are announced to the UI (a toast), never just logged: a silent button looks broken. */
export const ACTION_FAILED = 'kuebec:action-failed'
const fail = (message: string) => window.dispatchEvent(new CustomEvent(ACTION_FAILED, { detail: message }))

async function call(method: string, path: string, body?: unknown) {
  let res: Response
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    return fail('Could not reach the backend. Is it running on port 8000?')
  }
  if (res.ok) return
  const detail = await res.json().then((j) => j?.detail).catch(() => null)
  fail(res.status === 409 ? `${detail ?? 'Not allowed'}: the city is watching a real cluster.`
    : res.status === 404 && detail === 'not found' ? 'That object no longer exists (it may have just been replaced).'
      : res.status === 404 || res.status === 405 ? 'The backend does not know this action: it is probably running older code. Restart it.'
        : `The action failed (${res.status}${detail ? `: ${detail}` : ''}).`)
}

export const api = {
  demolish: (ns: string, pod: string) => call('DELETE', `/namespaces/${ns}/pods/${pod}`),
  scale: (ns: string, dep: string, replicas: number) =>
    call('PUT', `/namespaces/${ns}/deployments/${dep}/scale`, { replicas }),
  sabotage: (ns: string, dep: string, enabled: boolean) =>
    call('PUT', `/namespaces/${ns}/deployments/${dep}/sabotage`, { enabled }),
  outage: (node: string, enabled: boolean) => call('PUT', `/nodes/${node}/outage`, { enabled }),
  release: (ns: string, dep: string, buggy: boolean) => call('POST', `/namespaces/${ns}/deployments/${dep}/release`, { buggy }),
  rollback: (ns: string, dep: string) => call('POST', `/namespaces/${ns}/deployments/${dep}/rollback`),
  drain: (node: string, enabled: boolean) => call('PUT', `/nodes/${node}/drain`, { enabled }),
  rushHour: (enabled: boolean) => call('PUT', '/rush-hour', { enabled }),
  reset: () => call('POST', '/reset'),
}
