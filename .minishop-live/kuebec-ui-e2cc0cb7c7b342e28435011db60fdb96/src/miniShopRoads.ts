import architecture from '../../minishop/architecture.json' with { type: 'json' }
import type { Call } from './layout.ts'
import { roadKey } from './roadDiscovery.ts'

const namespace = architecture.namespace
const service = (name: string) => `${namespace}/${name}`
const components = new Set(architecture.components.map((component) => service(component.deployment)))
const declared = architecture.components.flatMap(({ deployment, dependencies }) =>
  dependencies.map((dependency) => ({ from: service(deployment), to: service(dependency) })))

export function miniShopLayoutCalls(calls: Call[], workloads: string[]) {
  const lots = new Set(workloads)
  const known = new Map(declared.filter(({ from, to }) => lots.has(from) && lots.has(to))
    .map((call) => [roadKey(call), call]))
  const supplemental: Call[] = []
  for (const call of calls) {
    const key = roadKey(call)
    if (!components.has(call.from) || !components.has(call.to)) known.set(key, call)
    else if (!known.has(key)) supplemental.push(call)
  }
  return { known: [...known.values()].sort((a, b) => roadKey(a).localeCompare(roadKey(b))), supplemental }
}
