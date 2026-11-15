import { CubicBezierCurve3, Vector3 } from 'three'
import { BUILDING, type CityLayout, offsetPath } from './layout.ts'

export const ROUNDABOUT_ASPHALT = 3.7
export const ROUNDABOUT_KERB = 4.2
export const ROUNDABOUT_ISLAND = 1.45
const approach = 3.2
const circle = 2.55
const blend = 0.48
const tau = Math.PI * 2

export const pointKey = (p: Vector3) => `${p.x},${p.z}`
export const HIGHWAY_GATE = '@highway/'
const arm = (origin: Vector3, end: Vector3) =>
  end.x > origin.x ? 'E' : end.x < origin.x ? 'W' : end.z > origin.z ? 'S' : 'N'

export type Roundabouts = Map<string, Vector3>

interface Link { to: string; length: number; points: Vector3[] }

/** Buildings are terminals. Roads connect to each other only at paved roundabouts. */
export function roundaboutRoutes(roads: Record<string, Vector3[]>, roundabouts: Roundabouts) {
  const links = new Map<string, Link[]>()
  const add = (from: string, link: Link) => {
    const exits = links.get(from) ?? []
    exits.push(link)
    links.set(from, exits)
  }
  for (const [key, road] of Object.entries(roads)) {
    let [from, destination] = key.split('>')
    let start = 0, length = 0
    for (let i = 1; i < road.length; i++) {
      length += road[i - 1].distanceTo(road[i])
      const junction = pointKey(road[i])
      const to = i === road.length - 1 ? destination : roundabouts.has(junction) ? junction : null
      if (to === null) continue
      const points = road.slice(start, i + 1)
      add(from, { to, length, points })
      add(to, { to: from, length, points: [...points].reverse() })
      from = to
      start = i
      length = 0
    }
  }
  return (from: string, to: string): Vector3[] | undefined => {
    if (!links.has(from) || !links.has(to)) return
    const distance = new Map([[from, 0]])
    const open = new Set([from])
    const previous = new Map<string, { from: string; points: Vector3[] }>()
    while (open.size) {
      let next = from, shortest = Infinity
      for (const node of open) {
        const cost = distance.get(node)!
        if (cost < shortest) { next = node; shortest = cost }
      }
      if (next === to) {
        const legs: Vector3[][] = []
        for (let node = to; node !== from;) {
          const leg = previous.get(node)!
          legs.push(leg.points)
          node = leg.from
        }
        return legs.reverse().flatMap((points, i) => i ? points.slice(1) : points)
      }
      open.delete(next)
      if (next !== from && !roundabouts.has(next) && !next.startsWith(HIGHWAY_GATE)) continue
      for (const link of links.get(next) ?? []) {
        const cost = shortest + link.length
        if (cost >= (distance.get(link.to) ?? Infinity)) continue
        distance.set(link.to, cost)
        previous.set(link.to, { from: next, points: link.points })
        open.add(link.to)
      }
    }
  }
}

export function findRoundabouts(layout: CityLayout, roads: Record<string, Vector3[]>, existing?: Roundabouts): Roundabouts {
  const junctions = new Map<string, { center: Vector3; arms: Set<string>; roads: number }>()
  const shortApproaches = new Set<string>()
  for (const [id, road] of Object.entries(roads)) {
    const visited = new Set<string>()
    const ends = id.split('>')
    for (let i = 0; i < road.length; i++) {
      const center = road[i]
      const key = pointKey(center)
      const adjacent = [road[i - 1], road[i + 1]].filter(Boolean)
      if ((i === 0 && ends[0] !== key) || (i === road.length - 1 && ends[1] !== key)) continue
      if (adjacent.some((p) => center.distanceTo(p) <= approach)) {
        shortApproaches.add(key)
        continue
      }
      const junction = junctions.get(key) ?? { center, arms: new Set<string>(), roads: 0 }
      adjacent.forEach((p) => junction.arms.add(arm(center, p)))
      if (!visited.has(key)) junction.roads++
      visited.add(key)
      junctions.set(key, junction)
    }
  }
  const fits = roundaboutClearance(layout, existing)
  const result: Roundabouts = new Map(existing)
  for (const [key, { center, arms, roads }] of junctions) {
    if (result.has(key) || roads < 2 || arms.size < 3 || shortApproaches.has(key) || !fits(center)) continue
    if ([...result.values()].some((p) => p.distanceTo(center) < 2 * ROUNDABOUT_KERB)) continue
    result.set(key, center)
  }
  return result
}

export function roundaboutClearance(layout: CityLayout, roundabouts?: Roundabouts) {
  const obstacles = [
    ...Object.values(layout.lots).map(({ center }) =>
      ({ center, w: BUILDING.halfW, back: BUILDING.back, front: BUILDING.front })),
    ...Object.values(layout.stations).map(({ center }) => ({ center, w: 6, back: -6, front: 6 })),
    ...(layout.hall ? [{ center: layout.hall.center, w: 9, back: -7, front: 7 }] : []),
  ]
  return (center: Vector3) => !obstacles.some((o) => Math.hypot(
      Math.max(Math.abs(center.x - o.center.x) - o.w, 0),
      Math.max(o.center.z + o.back - center.z, center.z - o.center.z - o.front, 0),
    ) < ROUNDABOUT_KERB) && ![...(roundabouts?.values() ?? [])].some((p) => p.distanceTo(center) < 2 * ROUNDABOUT_KERB)
}

const toward = (from: Vector3, to: Vector3) => to.clone().sub(from).normalize()
const onApproach = (center: Vector3, ray: Vector3) => center.clone().addScaledVector(ray, approach)

/** Stop the asphalt and road markings at the circular junction. */
export function roadSections(road: Vector3[], roundabouts: Roundabouts): Vector3[][] {
  const sections: Vector3[][] = []
  let section = [roundabouts.has(pointKey(road[0])) ? onApproach(road[0], toward(road[0], road[1])) : road[0]]
  for (let i = 1; i < road.length - 1; i++) {
    const p = road[i]
    if (roundabouts.has(pointKey(p))) {
      section.push(onApproach(p, toward(p, road[i - 1])))
      sections.push(section)
      section = [onApproach(p, toward(p, road[i + 1]))]
    } else section.push(p)
  }
  const end = road[road.length - 1]
  sections.push([...section, roundabouts.has(pointKey(end)) ? onApproach(end, toward(end, road[road.length - 2])) : end])
  return sections
}

/** Right-hand traffic merges tangentially into the circle and takes the route's exit. */
export function roundaboutLane(road: Vector3[], offset: number, roundabouts: Roundabouts): Vector3[] {
  const lane = offsetPath(road, offset)
  return lane.flatMap((point, i) => {
    const center = road[i]
    if (!i || i === lane.length - 1 || !roundabouts.has(pointKey(center))) return [point]
    const entryRay = toward(center, road[i - 1]), exitRay = toward(center, road[i + 1])
    const entry = Math.atan2(entryRay.z, entryRay.x)
    const exit = Math.atan2(exitRay.z, exitRay.x)
    const sweep = (entry - exit + tau) % tau || tau
    const start = entry - blend
    const end = start - (sweep - 2 * blend)
    const at = (angle: number) => center.clone().add(new Vector3(circle * Math.cos(angle), 0, circle * Math.sin(angle)))
    const tangent = (angle: number) => new Vector3(Math.sin(angle), 0, -Math.cos(angle))
    const startLane = onApproach(center, entryRay).add(new Vector3(entryRay.z * offset, 0, -entryRay.x * offset))
    const endLane = onApproach(center, exitRay).add(new Vector3(-exitRay.z * offset, 0, exitRay.x * offset))
    const merge = new CubicBezierCurve3(startLane, startLane.clone().addScaledVector(entryRay, -0.6),
      at(start).addScaledVector(tangent(start), -0.6), at(start))
    const leave = new CubicBezierCurve3(at(end), at(end).addScaledVector(tangent(end), 0.6),
      endLane.clone().addScaledVector(exitRay, -0.6), endLane)
    const steps = Math.ceil((sweep - 2 * blend) / 0.16)
    return [...merge.getPoints(4), ...Array.from({ length: steps }, (_, j) =>
      at(start + (end - start) * (j + 1) / steps)), ...leave.getPoints(4).slice(1)]
  })
}
