import type { ClusterState, Edge } from './k8s.ts'
import { discoveryReady, roadKey, type RoadDiscovery } from './roadDiscovery.ts'

export const DISCOVERY_CAR_DENSITY = 0.6
export const TRAFFIC_WINDOW_SECONDS = 5
export type ConnectionPurpose = { source: string; destination: string; kind: 'HTTP' | 'Database operation' | 'Cache operation' | 'Measured communication'; description: string }
const names: Record<string,string> = {'minishop-web':'Storefront','cart-api':'Cart','product-api':'Product','checkout-api':'Checkout','payment-api':'Payment','postgres':'PostgreSQL','redis':'Redis'}
// Reviewed against MiniShop handlers. These describe purpose, not an identified operation.
const purposes: Record<string,string> = {
  'minishop-web>product-api': 'The storefront requests catalogue information to display products.',
  'minishop-web>cart-api': 'The storefront asks Cart to read or change the shopping basket.',
  'minishop-web>checkout-api': 'The storefront asks Checkout to place an order or retrieve saved orders.',
  'cart-api>product-api': 'Cart requests product information to validate items or display basket details.',
  'cart-api>redis': 'Cart reads, updates or coordinates the stored shopping basket in Redis.',
  'product-api>postgres': 'Product accesses the product catalogue stored in PostgreSQL.',
  'checkout-api>cart-api': 'Checkout asks Cart for a basket snapshot or to finalise basket coordination.',
  'checkout-api>product-api': 'Checkout requests current catalogue information to check an order.',
  'checkout-api>payment-api': 'Checkout requests a simulated payment before completing a new order.',
  'checkout-api>postgres': 'Checkout reads saved orders or coordinates saving an order in PostgreSQL.',
}

export function connectionPurpose(edge: Pick<Edge,'from'|'to'>): ConnectionPurpose {
  const [sourceNamespace,from] = edge.from.split('/'), [targetNamespace,to] = edge.to.split('/')
  const reviewed = sourceNamespace === 'minishop' && targetNamespace === 'minishop' ? purposes[`${from}>${to}`] : undefined
  return {
    source: reviewed ? names[from] : edge.from,
    destination: reviewed ? names[to] : edge.to,
    kind: !reviewed ? 'Measured communication' : to === 'postgres' ? 'Database operation' : to === 'redis' ? 'Cache operation' : 'HTTP',
    description: reviewed ?? 'Communication was observed between these workloads. Its architectural purpose has not been reviewed.',
  }
}

/** Current window only: never add rolling counts together or turn them into events. */
export function recentConnections(cluster: ClusterState, discovery: RoadDiscovery | null): Edge[] {
  if (!discovery || !discovery.armed || !discoveryReady(cluster) || discovery.source !== cluster.metrics?.source_id) return []
  const services = new Map(cluster.metrics.services.map(service => [service.service,service]))
  return cluster.edges.filter(edge => {
    const caller = services.get(edge.from), callee = services.get(edge.to)
    return edge.from !== edge.to && discovery.roads.has(roadKey(edge)) &&
      caller?.deployment_uid && callee?.deployment_uid &&
      cluster.objects[caller.deployment_uid] && cluster.objects[callee.deployment_uid] &&
      caller.window_complete && Number.isSafeInteger(edge.requests) && edge.requests! > 0 &&
      Number.isFinite(edge.rps) && edge.rps > 0
  }).sort((a,b) => b.rps-a.rps || b.requests!-a.requests! || roadKey(a).localeCompare(roadKey(b))).slice(0,12)
}
