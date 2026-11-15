import * as THREE from 'three'
import { BUILDING, STREET_GRID as GRID, type Call, type CityLayout, type Rect } from './layout.ts'

// Junctions must fit between adjacent grid points with space for the approaches.
export const ROUNDABOUT_RADIUS = 2.35
export const HIGHWAY_WIDTH = 4.5
const CLEARANCE = 4.7
const BEND_RADIUS = 2.4
const FULL_TURN = 2 * Math.PI
const keyOf = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`

export interface StreetRoute { outbound: THREE.Vector3[]; inbound: THREE.Vector3[] }
export interface Street { key: string; points: THREE.Vector3[]; calls: string[]; highway: boolean }
export interface Roundabout { key: number; center: THREE.Vector3; calls: string[] }

export function districtOf(service: string) {
  return service.replace(/^ingress:/, '').split('/')[0]
}

export function crossesDistricts({ from, to }: Call) {
  return districtOf(from) !== districtOf(to)
}

function toward(from: THREE.Vector3, to: THREE.Vector3, distance: number) {
  return to.clone().sub(from).normalize().multiplyScalar(distance).add(from)
}

function around(center: THREE.Vector3, from: THREE.Vector3, to: THREE.Vector3) {
  const radius = ROUNDABOUT_RADIUS
  const approach = radius + 1.5
  const entry = Math.atan2(from.z - center.z, from.x - center.x) - 0.45
  const exit = Math.atan2(to.z - center.z, to.x - center.x) + 0.45
  const sweep = ((entry - exit) % FULL_TURN + FULL_TURN) % FULL_TURN
  const point = (angle: number) => new THREE.Vector3(center.x + radius * Math.cos(angle), 0, center.z + radius * Math.sin(angle))
  const tangent = (angle: number) => new THREE.Vector3(Math.sin(angle), 0, -Math.cos(angle))
  const start = toward(center, from, approach), end = toward(center, to, approach)
  const a = point(entry), b = point(exit)
  const inCurve = new THREE.CubicBezierCurve3(start, toward(start, center, 0.95), a.clone().addScaledVector(tangent(entry), -0.85), a)
  const outCurve = new THREE.CubicBezierCurve3(b, b.clone().addScaledVector(tangent(exit), 0.85), toward(end, center, 0.95), end)
  const steps = Math.ceil(sweep * 10)
  return [...inCurve.getPoints(8), ...Array.from({ length: steps - 1 }, (_, i) => point(entry - sweep * (i + 1) / steps)), ...outCurve.getPoints(8)]
}

function smooth(points: THREE.Vector3[], junctions: Set<THREE.Vector3>, drive: boolean) {
  // Keep junction vertices even when the incoming and outgoing streets are collinear.
  const corners = points.filter((p, i) => {
    const a = points[i - 1], b = points[i + 1]
    return !a || !b || junctions.has(p) || !((a.x === p.x && b.x === p.x) || (a.z === p.z && b.z === p.z))
  })
  return corners.flatMap((p, i) => {
    const a = corners[i - 1], b = corners[i + 1]
    if (junctions.has(p)) {
      if (a && b && drive) return around(p, a, b)
      if (!a || !b) return [toward(p, a ?? b, ROUNDABOUT_RADIUS - 0.25)]
    }
    if (!a || !b) return [p]
    const r = Math.min(BEND_RADIUS, p.distanceTo(a) / 2, p.distanceTo(b) / 2)
    return new THREE.QuadraticBezierCurve3(toward(p, a, r), p, toward(p, b, r)).getPoints(9)
  })
}

interface SearchEntry { node: number; cost: number }

// Priority queue for finding a route that adds the fewest grid edges.
class Frontier {
  private readonly items: SearchEntry[] = []
  push(entry: SearchEntry) {
    const items = this.items
    let i = items.length
    items.push(entry)
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (items[parent].cost <= entry.cost) break
      items[i] = items[parent]
      i = parent
    }
    items[i] = entry
  }
  pop(): SearchEntry | undefined {
    const items = this.items, first = items[0], last = items.pop()
    if (!items.length || !last) return first
    let i = 0
    while (2 * i + 1 < items.length) {
      let child = 2 * i + 1
      if (child + 1 < items.length && items[child + 1].cost < items[child].cost) child++
      if (last.cost <= items[child].cost) break
      items[i] = items[child]
      i = child
    }
    items[i] = last
    return first
  }
}

/** Lay out shared two-way streets independently of traffic rates and visibility. */
export function buildStreetNetwork(layout: CityLayout, calls: Call[], supplemental: Call[] = []) {
  const terminals = { ...layout.lots, ...layout.gates }
  const boxes: Record<string, Rect> = Object.fromEntries([
    ...Object.values(terminals), ...Object.values(layout.stations), ...(layout.hall ? [layout.hall] : []),
  ].map(({ key, center: { x, z } }) => [key, {
    x0: x - BUILDING.halfW - CLEARANCE, x1: x + BUILDING.halfW + CLEARANCE,
    z0: z + BUILDING.back - CLEARANCE, z1: z + BUILDING.front + CLEARANCE,
  }]))
  const obstacles = Object.values(boxes)
  const minX = Math.floor(Math.min(layout.core.x0, ...obstacles.map((b) => b.x0)) / GRID) - 1
  const minZ = Math.floor(Math.min(layout.core.z0, ...obstacles.map((b) => b.z0)) / GRID) - 1
  const width = Math.ceil(Math.max(layout.core.x1, ...obstacles.map((b) => b.x1)) / GRID) - minX + 2
  const highwayRow = Math.ceil(Math.max(layout.core.z1, ...obstacles.map((b) => b.z1)) / GRID) + 2
  const height = highwayRow - minZ + 2
  const size = width * height
  const nodeAt = (x: number, z: number) => (z - minZ) * width + x - minX
  const points = new Map<number, THREE.Vector3>()
  const point = (id: number) => {
    let p = points.get(id)
    if (!p) {
      p = new THREE.Vector3((id % width + minX) * GRID, 0, (Math.floor(id / width) + minZ) * GRID)
      points.set(id, p)
    }
    return p
  }
  const intersects = (a: THREE.Vector3, b: THREE.Vector3, box: Rect) =>
    Math.max(a.x, b.x) > box.x0 && Math.min(a.x, b.x) < box.x1 &&
    Math.max(a.z, b.z) > box.z0 && Math.min(a.z, b.z) < box.z1
  const neighbours = new Map<number, number[]>()
  const adjacent = (id: number) => {
    let list = neighbours.get(id)
    if (!list) {
      const a = point(id)
      list = [id % width > 0 ? id - 1 : -1, id % width < width - 1 ? id + 1 : -1, id - width, id + width]
        .filter((next) => next >= 0 && next < size && !obstacles.some((box) => intersects(a, point(next), box)))
      neighbours.set(id, list)
    }
    return list
  }
  const streets = new Map<string, Set<string>>()
  const highwayEdges = new Set<string>()
  const interchanges = new Set<number>()
  const districts = new Map(layout.districts.map((district, i, all) => {
    const left = all[i - 1], right = all[i + 1]
    const min = left ? (left.x1 + district.x0) / 2 : -Infinity
    const max = right ? (district.x1 + right.x0) / 2 : Infinity
    return [district.name, {
      landing: nodeAt(Math.round((district.x0 + district.x1) / (2 * GRID)), highwayRow),
      contains: (id: number) => point(id).x >= min && point(id).x < max && point(id).z <= highwayRow * GRID,
    }]
  }))
  const connected = new Map<number, Set<number>>()
  const add = (a: number, b: number, call: string) => {
    const key = keyOf(a, b), users = streets.get(key)
    if (users) { users.add(call); return }
    streets.set(key, new Set([call]))
    if (!connected.has(a)) connected.set(a, new Set())
    if (!connected.has(b)) connected.set(b, new Set())
    connected.get(a)!.add(b)
    connected.get(b)!.add(a)
  }
  const doors = new Map<string, { door: number; portal: number }>()
  const driveway = (name: string, other: THREE.Vector3) => {
    const existing = doors.get(name)
    if (existing) return existing
    const center = terminals[name].center, box = boxes[name], gate = !!layout.gates[name]
    const x = Math.round(center.x / GRID), z = Math.round(center.z / GRID)
    const candidates = [
      { x: Math.ceil(box.x1 / GRID), z, end: new THREE.Vector3(center.x - (gate ? 14 : 0), 0, z * GRID) },
      { x: Math.floor(box.x0 / GRID), z, end: new THREE.Vector3(center.x, 0, z * GRID) },
      { x, z: Math.ceil(box.z1 / GRID), end: new THREE.Vector3(x * GRID, 0, center.z) },
      { x, z: Math.floor(box.z0 / GRID), end: new THREE.Vector3(x * GRID, 0, center.z) },
    ].filter((c) => {
      const portal = nodeAt(c.x, c.z)
      return districts.get(districtOf(name))?.contains(portal) && adjacent(portal).length && !obstacles.some((otherBox) => otherBox !== box && intersects(c.end, point(portal), otherBox))
    })
    // Use a side door when possible, so entrances stay out of the pod forecourts.
    candidates.sort((a, b) => Number(a.x === x) - Number(b.x === x) ||
      point(nodeAt(a.x, a.z)).distanceToSquared(other) - point(nodeAt(b.x, b.z)).distanceToSquared(other))
    const choice = candidates[0]
    if (!choice) return
    const door = -doors.size - 1, portal = nodeAt(choice.x, choice.z)
    points.set(door, choice.end)
    const access = { door, portal }
    doors.set(name, access)
    return access
  }

  function route(start: number, goal: (id: number) => boolean, allowed: (id: number) => boolean) {
    const frontier = new Frontier(), costs = new Map([[start, 0]]), previous = new Map<number, number>()
    // A simple route uses at most `size` grid steps; new streets always cost more than all travel and turns.
    const construction = size * 5 + 1
    frontier.push({ node: start, cost: 0 })
    for (let entry: SearchEntry | undefined = frontier.pop(); entry; entry = frontier.pop()) {
      const { node, cost } = entry
      if (cost !== costs.get(node)) continue
      if (goal(node)) {
        const path = [node]
        while (path.at(-1) !== start) path.push(previous.get(path.at(-1)!)!)
        return path.reverse()
      }
      const prior = previous.get(node)
      for (const next of adjacent(node)) {
        if (!allowed(next)) continue
        const turn = prior !== undefined && node - prior !== next - node
        const nextCost = cost + (streets.has(keyOf(node, next)) ? 0 : construction) + 4 + Number(turn)
        if (nextCost >= (costs.get(next) ?? Infinity)) continue
        costs.set(next, nextCost)
        previous.set(next, node)
        frontier.push({ node: next, cost: nextCost })
      }
    }
  }
  type DistrictAccess = NonNullable<ReturnType<typeof districts.get>>

  function approach(portal: number, { landing, contains }: DistrictAccess) {
    const reachable = new Set([portal]), queue = [portal]
    for (const node of queue) {
      for (const next of connected.get(node) ?? []) {
        if (next < 0 || reachable.has(next) || !contains(next) || highwayEdges.has(keyOf(node, next))) continue
        reachable.add(next)
        queue.push(next)
      }
    }
    if (reachable.has(landing)) return route(portal, (id) => id === landing, (id) => reachable.has(id))
    // Tie the ramp into a reachable roundabout first. A through street can gain a new
    // roundabout if there is no usable junction, and a lone building gets its own access.
    for (const degree of [3, 2, 0]) {
      const branch = (id: number) => reachable.has(id) && ((connected.get(id)?.size ?? 0) >= degree || interchanges.has(id))
      if (!queue.some(branch)) continue
      const ramp = route(landing, branch, (id) => contains(id) && (!reachable.has(id) || branch(id)) && point(id).z < highwayRow * GRID)
      if (!ramp) continue
      const local = route(portal, (id) => id === ramp.at(-1), (id) => reachable.has(id))
      if (local) return [...local, ...ramp.reverse().slice(1)]
    }
  }

  const paths = new Map<string, number[]>()
  const valid = (list: Call[]) => list.filter(({ from, to }) => from !== to && terminals[from] && layout.lots[to])
  const order = (list: Call[]) => valid(list).sort((a, b) =>
    terminals[a.from].center.manhattanDistanceTo(terminals[a.to].center) - terminals[b.from].center.manhattanDistanceTo(terminals[b.to].center) ||
    `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`))
  const ordered = [...order(calls), ...order(supplemental)]
  for (const { from, to } of [...ordered.filter((call) => !crossesDistricts(call)), ...ordered.filter(crossesDistricts)]) {
    const key = `${from}>${to}`
    if (paths.has(key)) continue
    const startDistrict = districts.get(districtOf(from)), endDistrict = districts.get(districtOf(to))
    const start = driveway(from, terminals[to].center), end = driveway(to, terminals[from].center)
    if (!start || !end || !startDistrict || !endDistrict) continue
    let middle: number[] | undefined
    if (startDistrict === endDistrict) {
      middle = route(start.portal, (id) => id === end.portal, (id) => startDistrict.contains(id) && point(id).z < highwayRow * GRID)
    } else {
      const departure = approach(start.portal, startDistrict), arrival = approach(end.portal, endDistrict)
      if (!departure || !arrival) continue
      const a = startDistrict.landing, b = endDistrict.landing, direction = Math.sign(b - a)
      const highway = Array.from({ length: Math.abs(b - a) + 1 }, (_, i) => a + i * direction)
      highway.slice(1).forEach((next, i) => highwayEdges.add(keyOf(highway[i], next)))
      interchanges.add(a)
      interchanges.add(b)
      middle = [...departure, ...highway.slice(1), ...arrival.reverse().slice(1)]
    }
    if (!middle) continue
    const path = [start.door, ...middle, end.door]
    path.slice(1).forEach((b, i) => add(path[i], b, key))
    paths.set(key, path)
  }
  const junctionIds = [...connected].filter(([id, ends]) => ends.size > 2 || interchanges.has(id)).map(([id]) => id)
  const junctions = new Set(junctionIds.map(point))
  const roundabouts: Roundabout[] = junctionIds.map((id) => ({ key: id, center: point(id),
    calls: [...new Set([...connected.get(id)!].flatMap((end) => [...streets.get(keyOf(id, end))!]))] }))
  const segments: Street[] = [], seen = new Set<string>()
  for (const [start, ends] of connected) {
    if (ends.size === 2 && !interchanges.has(start)) continue
    for (const first of ends) {
      const key = keyOf(start, first)
      if (seen.has(key)) continue
      const path = [start, first]
      seen.add(key)
      let current = first, previous = start
      while (connected.get(current)!.size === 2 && !interchanges.has(current)) {
        const next = [...connected.get(current)!].find((n) => n !== previous)!
        seen.add(keyOf(current, next))
        path.push(next)
        previous = current
        current = next
      }
      segments.push({ key, points: smooth(path.map(point), junctions, false), calls: [...streets.get(key)!], highway: highwayEdges.has(key) })
    }
  }
  const routes: Record<string, StreetRoute> = Object.fromEntries([...paths].map(([key, path]) => {
    const polyline = path.map(point)
    return [key, { outbound: smooth(polyline, junctions, true), inbound: smooth(polyline.reverse(), junctions, true) }]
  }))
  return { segments, roundabouts, routes }
}
