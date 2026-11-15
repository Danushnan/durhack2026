import type { Call } from './layout.ts'
import { crossesDistricts } from './streetNetwork.ts'

export const DEMO_DEPOT = 'demo-transit/depot'

export interface DemoPackets {
  routes: Record<string, { call: Call; count: number }>
  last: { local?: Call; cross?: Call }
  reset: number
}

export function queueDemoPackets(demo: DemoPackets, workloads: string[], count: number, cross: boolean, random: () => number): DemoPackets {
  const candidates = workloads.flatMap((from) => workloads.flatMap((to) => {
    const call = { from, to }
    return from !== to && crossesDistricts(call) === cross ? [call] : []
  }))
  if (cross && !candidates.length) {
    for (const workload of workloads) {
      candidates.push({ from: workload, to: DEMO_DEPOT }, { from: DEMO_DEPOT, to: workload })
    }
  }
  if (!candidates.length) return demo

  const kind = cross ? 'cross' : 'local'
  const routes = { ...demo.routes }
  let previous = demo.last[kind]
  let unused = [...candidates]
  for (let i = 0; i < count; i++) {
    if (!unused.length) unused = [...candidates]
    // Vary both ends where possible and use every eligible pair before recycling the batch.
    const different = unused.filter(({ from, to }) => from !== previous?.from && to !== previous?.to)
    const choices = different.length ? different : unused
    const call = choices[Math.floor(random() * choices.length)]
    unused.splice(unused.indexOf(call), 1)
    const key = `${call.from}>${call.to}`
    routes[key] = { call, count: (routes[key]?.count ?? 0) + 1 }
    previous = call
  }
  return { ...demo, routes, last: { ...demo.last, [kind]: previous } }
}
