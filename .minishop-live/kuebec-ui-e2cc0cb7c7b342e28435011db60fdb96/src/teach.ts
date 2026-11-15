import type { Edge, K8sObject } from './k8s'
import { keyOf } from './k8s'

/** The same kind of service under other names (MiniShop's `payment-api`, `minishop-web`, …) gets the same Building and role. */
const ALIAS: Record<string, string> = { 'minishop-web': 'frontend', web: 'frontend', payment: 'payments', product: 'products', catalog: 'products' }
export const canonical = (service: string) => { const s = service.replace(/-(api|service|svc)$/, ''); return ALIAS[s] ?? s }

/** What each service is for, and what users would notice if it stopped. */
const ROLES: Record<string, { does: string; ifDown: string }> = {
  frontend: { does: 'The shop website customers browse.', ifDown: 'Customers cannot load the shop at all.' },
  cart: { does: 'Remembers what each customer has put in their basket.', ifDown: 'Customers cannot add items; baskets look empty.' },
  checkout: { does: 'Turns a basket into an order.', ifDown: 'Customers can browse but cannot buy anything.' },
  payments: { does: 'Authorises payments; MiniShop uses a simulated provider.', ifDown: 'Orders fail at the very last step: nobody can pay.' },
  postgres: { does: 'The database: the permanent record of every order.', ifDown: 'Checkout cannot save orders.' },
  redis: { does: 'A fast in-memory cache that holds basket data.', ifDown: 'The cart cannot read or save baskets.' },
  products: { does: 'The catalogue: product details, prices and stock.', ifDown: 'The shop shows no products, and baskets cannot price items.' },
}
export const roleOf = (service: string) =>
  ROLES[canonical(service)] ?? { does: 'A service running in the cluster.', ifDown: 'Anything that calls it will start failing.' }

/** Why Kubernetes did each thing, in one plain sentence. */
const EXPLAIN: Record<string, string> = {
  SuccessfulCreate: 'The ReplicaSet had fewer Pods than desired, so it created one. This is the control loop at work.',
  SuccessfulDelete: 'The ReplicaSet had more Pods than desired, so it deleted one.',
  Scheduled: 'The scheduler picked a Node (Power Station) with a free slot, spreading copies of a service across Nodes.',
  Started: 'The container started running inside the Pod.',
  BackOff: 'The app keeps crashing. Kubernetes keeps restarting it, waiting longer each time so it does not hammer the Node.',
  Killing: 'Kubernetes is stopping this Pod gracefully.',
  FailedScheduling: 'No Node has a free slot, so the Pod waits in Pending until space appears.',
  ScalingReplicaSet: 'The Deployment changed how many Pods its ReplicaSet (one per version) should run. During a release it grows the new ReplicaSet and shrinks the old one a few Pods at a time.',
  ProgressDeadlineExceeded: 'The new version never became ready, so the rollout stopped. The old version keeps serving; roll back, or release a fix.',
  DeploymentRollback: 'The Deployment went back to the previous version. Kubernetes rolls back as carefully as it rolls forward.',
  NodeNotReady: 'A Node stopped sending heartbeats. Kubernetes tainted it unreachable and took its Pods out of rotation; they are evicted if it stays silent.',
  NodeReady: 'The Node is healthy again and can accept new Pods.',
  TaintManagerEviction: 'The Node stayed unreachable longer than its Pods tolerate, so they are marked for deletion. They stay Terminating until the Node confirms; a Deployment starts replacements elsewhere meanwhile, a StatefulSet waits.',
  SuccessfulRescale: 'The autoscaler compared requests per Unit with its target and changed how many Units the service should run.',
  NodeNotSchedulable: 'The Node was cordoned: no new Pods will be placed on it (the first step of kubectl drain).',
  NodeSchedulable: 'The Node was uncordoned and can accept new Pods again.',
  Reset: 'The demo city was put back to its starting state.',
  Sabotaged: 'Every copy now crashes, old and new alike, as if a shared config or dependency broke. A careful rollout cannot protect you from this.',
  Repaired: 'The breakage is fixed; the next restart will succeed.',
}
export const explain = (e: K8sObject) => EXPLAIN[e.reason ?? ''] ?? ''

/** Services that are completely unavailable (desired > 0 but nothing ready, or scaled to zero). */
export function downServices(deployments: K8sObject[]): Set<string> {
  return new Set(deployments.filter((d) => (d.status?.readyReplicas ?? 0) === 0).map(keyOf))
}

/**
 * For a running service, the chain of dependencies that explains why it is Impacted,
 * e.g. ['shop/checkout', 'shop/payments'] means "checkout is struggling because payments is down".
 */
export function impactChain(key: string, edges: Edge[], down: Set<string>, seen = new Set<string>()): string[] | null {
  if (seen.has(key)) return null
  seen.add(key)
  for (const e of edges.filter((x) => x.from === key)) {
    if (down.has(e.to)) return [e.to]
    const deeper = impactChain(e.to, edges, down, seen)
    if (deeper) return [e.to, ...deeper]
  }
  return null
}

export const nameOf = (key: string) => key.split('/')[1]

/** The kubectl command each button in the city stands for. */
export const kubectl = {
  scale: (ns: string, dep: string, n: number) => `kubectl scale deploy/${dep} --replicas=${n} -n ${ns}`,
  release: (ns: string, dep: string, v: string) => `kubectl set image deploy/${dep} app=${dep}:${v} -n ${ns}`,
  rollback: (ns: string, dep: string) => `kubectl rollout undo deploy/${dep} -n ${ns}`,
  demolish: (ns: string, pod: string) => `kubectl delete pod ${pod} -n ${ns}`,
  drain: (node: string) => `kubectl drain ${node} --ignore-daemonsets`,
  uncordon: (node: string) => `kubectl uncordon ${node}`,
  hpa: (ns: string, dep: string) => `kubectl get hpa ${dep} -n ${ns}`,
}

/** The parts of the control plane that report events, and the colour of their messengers. */
export const COMPONENTS: Record<string, { label: string; color: string; does: string }> = {
  'default-scheduler': { label: 'Scheduler', color: '#38bdf8', does: 'picks a Power Station for each new Pod' },
  'replicaset-controller': { label: 'ReplicaSet controller', color: '#a78bfa', does: 'creates and removes Pods to match the desired count' },
  'deployment-controller': { label: 'Deployment controller', color: '#c084fc', does: 'runs rollouts and rollbacks' },
  'statefulset-controller': { label: 'StatefulSet controller', color: '#f472b6', does: 'creates numbered Pods and their volumes, in order' },
  'horizontal-pod-autoscaler': { label: 'Autoscaler', color: '#34d399', does: 'changes the Unit count with the load' },
  'node-controller': { label: 'Node controller', color: '#fb923c', does: 'watches whether Power Stations are alive' },
  'taint-eviction-controller': { label: 'Eviction controller', color: '#f87171', does: 'evicts Pods from failed Power Stations' },
  kubelet: { label: 'Kubelet', color: '#facc15', does: 'the agent on each Power Station that starts and stops containers' },
}

/** Which part of Kubernetes reported an event: reportingComponent, or the older source.component real clusters often use. */
export const componentOf = (e: K8sObject) => e.reportingComponent || e.source?.component || ''
