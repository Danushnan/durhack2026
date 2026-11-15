import architecture from '../../minishop/architecture.json' with { type: 'json' }
import type { ClusterState, K8sObject } from './k8s.ts'

const components = new Set(architecture.components.map(component => component.deployment))
export const isMiniShopComponent = (object: K8sObject) =>
  object.metadata.namespace === architecture.namespace && components.has(object.metadata.name)

/** Scope the presentation only; the watch and measured telemetry stay intact. */
export function miniShopView(cluster: ClusterState): ClusterState {
  const objects = Object.values(cluster.objects)
  // Scope only when MiniShop is really there: live mode always carries MiniShop metrics, even for other demos.
  if (typeof cluster.context !== 'string' || !objects.some(isMiniShopComponent)) return cluster
  const visible = objects.filter(object => {
    if (object.kind === 'Node') return true
    if (object.metadata.namespace !== architecture.namespace) return false
    return !['Deployment', 'StatefulSet'].includes(object.kind) || isMiniShopComponent(object)
  })
  const workloads = new Set(visible.filter(object => ['Deployment', 'StatefulSet'].includes(object.kind))
    .map(object => `${object.metadata.namespace}/${object.metadata.name}`))
  return {
    ...cluster,
    objects: Object.fromEntries(visible.map(object => [object.metadata.uid, object])),
    edges: cluster.edges.filter(edge => workloads.has(edge.to) &&
      (workloads.has(edge.from) || edge.from.startsWith(`ingress:${architecture.namespace}/`))),
  }
}

/** Keep MiniShop and two small surrounding districts; filter the presentation only. */
export function demoCityView(cluster: ClusterState): ClusterState {
  if (typeof cluster.context !== 'string' || !Object.values(cluster.objects).some(isMiniShopComponent)) return cluster
  const namespaces = new Set([architecture.namespace, 'kubeverse-platform', 'kubeverse-fulfilment'])
  const visible = Object.values(cluster.objects).filter(object =>
    object.kind === 'Node' || (object.kind === 'Namespace'
      ? namespaces.has(object.metadata.name)
      : !!object.metadata.namespace && namespaces.has(object.metadata.namespace)))
  const workloads = new Set(visible.filter(object => ['Deployment', 'StatefulSet'].includes(object.kind))
    .map(object => `${object.metadata.namespace}/${object.metadata.name}`))
  return {
    ...cluster,
    objects: Object.fromEntries(visible.map(object => [object.metadata.uid, object])),
    edges: cluster.edges.filter(edge => workloads.has(edge.to) && (workloads.has(edge.from) ||
      edge.from.startsWith('ingress:') && namespaces.has(edge.from.slice(8).split('/')[0]))),
  }
}
