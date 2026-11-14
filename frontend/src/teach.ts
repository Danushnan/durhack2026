import type { Edge, K8sObject } from './k8s'
import { keyOf } from './k8s'

/** What each service is for, and what users would notice if it stopped. */
const ROLES: Record<string, { does: string; ifDown: string }> = {
  frontend: { does: 'The shop website customers browse.', ifDown: 'Customers cannot load the shop at all.' },
  cart: { does: 'Remembers what each customer has put in their basket.', ifDown: 'Customers cannot add items; baskets look empty.' },
  checkout: { does: 'Turns a basket into an order.', ifDown: 'Customers can browse but cannot buy anything.' },
  payments: { does: "Charges the customer's card.", ifDown: 'Orders fail at the very last step: nobody can pay.' },
  postgres: { does: 'The database: the permanent record of every order.', ifDown: 'Checkout cannot save orders.' },
  redis: { does: 'A fast in-memory cache that holds basket data.', ifDown: 'The cart cannot read or save baskets.' },
}
export const roleOf = (service: string) =>
  ROLES[service] ?? { does: 'A service running in the cluster.', ifDown: 'Anything that calls it will start failing.' }

/** Why Kubernetes did each thing, in one plain sentence. */
const EXPLAIN: Record<string, string> = {
  SuccessfulCreate: 'The Deployment had fewer Pods than desired, so it created one. This is the control loop at work.',
  Scheduled: 'The scheduler picked a Node (Power Station) with a free slot for this Pod.',
  Started: 'The container started running inside the Pod.',
  BackOff: 'The app keeps crashing. Kubernetes keeps restarting it, waiting longer each time so it does not hammer the Node.',
  Killing: 'Kubernetes is stopping this Pod gracefully.',
  FailedScheduling: 'No Node has a free slot, so the Pod waits in Pending until space appears.',
  ScalingReplicaSet: 'The desired number of Pods changed; Kubernetes adds or removes Pods until reality matches.',
  NodeNotReady: 'A Node stopped responding. Its Pods can no longer be trusted to run.',
  NodeReady: 'The Node is healthy again and can accept new Pods.',
  TaintManagerEviction: 'Pods on a failed Node are evicted so their Deployments can recreate them elsewhere.',
  Sabotaged: 'From now on this service crashes on start-up (a simulated bad release).',
  Repaired: 'The bad release is fixed; the next restart will succeed.',
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
