import { Vector3 } from 'three'
import { BUILDING, KERB, ROAD_W, type Call, type CityLayout, type District } from './layout.ts'
import { findRoundabouts, HIGHWAY_GATE, pointKey, roundaboutClearance, roundaboutRoutes, type Roundabouts } from './roundabouts.ts'

const step = 5
const margin = ROAD_W / 2 + KERB + 1
const moves = [[1, 0], [0, 1], [-1, 0], [0, -1]]
const drivewayInset = 1.4
const intervalOverlap = (a: number, b: number, c: number, d: number) =>
  Math.min(Math.max(a, b), Math.max(c, d)) > Math.max(Math.min(a, b), Math.min(c, d))
const namespaceOf = (key: string) => key.split('/')[0]
const inside = (p: Vector3, district: District, pad = 0) =>
  p.x >= district.x0 - pad && p.x <= district.x1 + pad && p.z >= district.z0 - pad && p.z <= district.z1 + pad
type Ports = Map<number, Vector3>

export const streetKey = (from: string, to: string) => from < to ? `${from}>${to}` : `${to}>${from}`

/** The same grid and first-seen order keep existing streets fixed as new calls arrive. */
export function buildLiveRoads(layout: CityLayout, calls: Call[]) {
  const lots = Object.values(layout.lots)
  const roads: Record<string, Vector3[]> = {}
  const routes: Record<string, Vector3[]> = {}
  let roundabouts: Roundabouts = new Map()
  const highways = new Set<string>()
  if (!lots.length || !calls.length) return { roads, routes, roundabouts, highways }

  const obstacles = [
    ...lots.map(({ center }) => ({ center, w: BUILDING.halfW, back: BUILDING.back, front: BUILDING.front })),
    ...Object.values(layout.stations).map(({ center }) => ({ center, w: 6, back: -6, front: 6 })),
    ...(layout.hall ? [{ center: layout.hall.center, w: 9, back: -7, front: 7 }] : []),
  ].map(({ center, w, back, front }) => ({
    x0: center.x - w - margin, x1: center.x + w + margin,
    z0: center.z + back - margin, z1: center.z + front + margin,
  }))
  const x0 = Math.floor(Math.min(...obstacles.map((r) => r.x0)) / step) - 2
  const z0 = Math.floor(Math.min(...obstacles.map((r) => r.z0)) / step) - 2
  const width = Math.ceil(Math.max(...obstacles.map((r) => r.x1)) / step) - x0 + 3
  const height = Math.ceil(Math.max(...obstacles.map((r) => r.z1)) / step) - z0 + 3
  const pointAt = (i: number) => new Vector3((x0 + i % width) * step, 0, (z0 + Math.floor(i / width)) * step)
  const points = Array.from({ length: width * height }, (_, i) => pointAt(i))
  const gridIndex = new Map(points.map((p, i) => [pointKey(p), i]))
  const clear = (a: Vector3, b: Vector3, except = -1) => obstacles.every((r, i) =>
    i === except || Math.max(a.x, b.x) <= r.x0 || Math.min(a.x, b.x) >= r.x1 ||
    Math.max(a.z, b.z) <= r.z0 || Math.min(a.z, b.z) >= r.z1)
  const neighbors = points.map((p, i) => moves.map(([dx, dz]) => {
    const column = i % width + dx, row = Math.floor(i / width) + dz
    const next = row * width + column
    return column >= 0 && column < width && row >= 0 && row < height && clear(p, points[next]) ? next : -1
  }))
  const lotPorts = new Map(lots.map(({ key, center }, lotIndex) => {
    const ports = new Map<number, Vector3>()
    points.forEach((p, index) => {
      if (!clear(p, p)) return
      const dx = p.x - center.x, x = Math.abs(dx), z = p.z - center.z
      const side = x >= BUILDING.halfW + margin && x < BUILDING.halfW + margin + step && Math.abs(z) <= 4.5
      const front = x <= 4.5 && z >= BUILDING.front + margin && z < BUILDING.front + margin + step
      const back = x <= 4.5 && z <= BUILDING.back - margin && z > BUILDING.back - margin - step
      if (!side && !front && !back) return
      const tip = side
        ? new Vector3(center.x + Math.sign(dx) * (BUILDING.halfW - drivewayInset), 0, p.z)
        : new Vector3(p.x, 0, center.z + (front ? BUILDING.front - 0.05 : BUILDING.back + drivewayInset))
      if (clear(tip, p, lotIndex)) ports.set(index, tip)
    })
    return [key, ports] as const
  }))
  const occupied = new Set<number>()
  const segment = (a: number, b: number) => Math.min(a, b) * points.length + Math.max(a, b)
  const usedSegments = new Set<number>()
  const pavedSegments: [Vector3, Vector3][] = []
  const overlaps = (a: Vector3, b: Vector3, c: Vector3, d: Vector3) =>
    (a.x === b.x && a.x === c.x && c.x === d.x && intervalOverlap(a.z, b.z, c.z, d.z)) ||
    (a.z === b.z && a.z === c.z && c.z === d.z && intervalOverlap(a.x, b.x, c.x, d.x))
  const freePort = (i: number, tip: Vector3) =>
    !pavedSegments.some(([a, b]) => overlaps(points[i], tip, a, b))
  const direction = (from: Vector3, to: Vector3) => from.x < to.x ? 0 : from.z < to.z ? 1 : from.x > to.x ? 2 : 3
  const pathBetween = (starts: Ports | undefined, destinations: Ports | undefined,
    allowed: (point: Vector3) => boolean = () => true,
    allowArrival: (index: number, previous: Vector3) => boolean = () => true,
    allowDeparture: (index: number, next: Vector3) => boolean = () => true,
    avoidCrossings = false) => {
    if (!starts?.size || !destinations?.size) return
    const ends = [...destinations].filter(([i, tip]) => freePort(i, tip)).map(([i]) => i)
    if (!ends.length) return
    const availableEnds = new Set(ends)
    const costs = new Float64Array(points.length * 4).fill(Infinity)
    const parents = new Int32Array(costs.length).fill(-1)
    const open = new Set<number>()
    for (const [i, tip] of starts) {
      if (!allowed(points[i]) || !freePort(i, tip)) continue
      const directions = tip.equals(points[i]) ? [0, 1, 2, 3] : [direction(tip, points[i])]
      for (const dir of directions) {
        const state = i * 4 + dir
        costs[state] = tip.distanceTo(points[i]) / step + (occupied.has(i) ? 12 : 0)
        open.add(state)
      }
    }
    const estimate = points.map((p) => Math.min(...ends.map((i) =>
      (Math.abs(points[i].x - p.x) + Math.abs(points[i].z - p.z)) / step)))
    while (open.size) {
      let state = -1, best = Infinity
      for (const candidate of open) {
        const score = costs[candidate] + estimate[candidate >> 2]
        if (score < best) { best = score; state = candidate }
      }
      open.delete(state)
      const index = state >> 2
      const end = destinations.get(index)
      if (end && availableEnds.has(index) && parents[state] >= 0 && allowArrival(index, points[parents[state] >> 2]) &&
        (end.equals(points[index]) || (state % 4 + 2) % 4 !== direction(points[index], end))) {
        const path: number[] = []
        for (let s = state; s >= 0; s = parents[s]) path.push(s >> 2)
        path.reverse()
        const road = [starts.get(path[0])!, ...path.map((i) => points[i]), end]
        return road.filter((p, i) => i === 0 || !p.equals(road[i - 1]))
      }
      neighbors[index].forEach((next, dir) => {
        if (next < 0 || dir === (state % 4 + 2) % 4 || !allowed(points[next])) return
        // Already paved edges are reserved, including those that are too tight for a roundabout.
        if (usedSegments.has(segment(index, next))) return
        if (avoidCrossings && occupied.has(next) && !availableEnds.has(next)) return
        if (parents[state] < 0 && !allowDeparture(index, points[next])) return
        const nextState = next * 4 + dir
        const cost = costs[state] + 1 + (dir === state % 4 ? 0 : 3) + (occupied.has(next) ? 5 : 0)
        if (cost >= costs[nextState]) return
        costs[nextState] = cost
        parents[nextState] = state
        open.add(nextState)
      })
    }
  }

  const districtByName = new Map(layout.districts.map((district) => [district.name, district]))
  const districtsByRoad = new Map<string, string>()
  const streetsIn = (district: District) =>
    Object.fromEntries(Object.entries(roads).filter(([id]) => districtsByRoad.get(id) === district.name))
  const gatewayPaths = new Map<string, { left: District; right: District; path: Vector3[]; start: string; end: string }>()
  const singleton = (p: Vector3): Ports => new Map([[gridIndex.get(pointKey(p))!, p]])
  const reserve = (road: Vector3[]) => {
    let previous: number | undefined
    for (const p of road) {
      const index = gridIndex.get(pointKey(p))
      if (index !== undefined) {
        occupied.add(index)
        if (previous !== undefined) usedSegments.add(segment(previous, index))
      }
      previous = index
    }
    road.slice(1).forEach((p, i) => pavedSegments.push([road[i], p]))
    // Driveways can occupy part of a grid edge even when their building end is off-grid.
    for (const i of [0, road.length - 2]) {
      const a = road[i], b = road[i + 1]
      if (gridIndex.has(pointKey(a)) && gridIndex.has(pointKey(b))) continue
      for (const endpoint of [a, b]) {
        const x = Math.floor(endpoint.x / step) * step, z = Math.floor(endpoint.z / step) * step
        const origin = gridIndex.get(`${x},${z}`)
        if (origin === undefined) continue
        for (const next of neighbors[origin]) {
          if (next >= 0 && overlaps(a, b, points[origin], points[next])) usedSegments.add(segment(origin, next))
        }
      }
    }
  }
  const restoreReservations = () => {
    occupied.clear()
    usedSegments.clear()
    pavedSegments.length = 0
    Object.values(roads).forEach(reserve)
  }
  const pave = (from: string, to: string, road: Vector3[], district?: string) => {
    const key = streetKey(from, to)
    roads[key] = from < to ? road : [...road].reverse()
    if (district) districtsByRoad.set(key, district)
    reserve(road)
    roundabouts = findRoundabouts(layout, roads, roundabouts)
    return key
  }

  const highwayBetween = (first: District, second: District) => {
    const pair = streetKey(first.name, second.name)
    const existing = gatewayPaths.get(pair)
    if (existing) return existing
    const [left, right] = first.x0 < second.x0 ? [first, second] : [second, first]
    const leftX = Math.ceil(left.x1 / step) * step
    const rightX = Math.floor(right.x0 / step) * step
    const edgePorts = (district: District, x: number, inward: number) => {
      const ports: Ports = new Map()
      points.forEach((p, index) => {
        if (p.x === x && inside(p, district, step) && clear(p, p) && !occupied.has(index) &&
          clear(p, p.clone().add(new Vector3(inward * step, 0, 0)))) ports.set(index, p)
      })
      return ports
    }
    const path = pathBetween(edgePorts(left, leftX, -1), edgePorts(right, rightX, 1),
      (p) => p.x >= leftX && p.x <= rightX && !layout.districts.some((district) =>
        district !== left && district !== right && inside(p, district, margin)),
      (index, previous) => previous.x < points[index].x,
      (index, next) => next.x > points[index].x)
    if (!path) return
    const id = `${HIGHWAY_GATE}${left.name}/${right.name}`
    const highway = { left, right, path, start: `${id}/left`, end: `${id}/right` }
    gatewayPaths.set(pair, highway)
    highways.add(pave(highway.start, highway.end, path))
    return highway
  }

  const connectLocal = (building: string, target: string, district: District,
    gateway?: { point: Vector3; inward: number }) => {
    const localRoads = streetsIn(district)
    const localRoute = roundaboutRoutes(localRoads, roundabouts)
    const existing = localRoute(building, target)
    if (existing) return existing
    const allowed = (p: Vector3) => inside(p, district, step) &&
      (!gateway || (gateway.inward < 0 ? p.x <= gateway.point.x : p.x >= gateway.point.x))
    const goesInward = (p: Vector3) => !gateway || Math.sign(p.x - gateway.point.x) === gateway.inward
    const planBranch = (from: string, ports: Ports | undefined, connectedTo: string,
      streets = localRoads, junctions = roundabouts, candidateStreets = streets) => {
      const destinations: Ports = new Map()
      const arms = new Map<number, Set<string>>()
      const fits = roundaboutClearance(layout, junctions)
      for (const road of Object.values(candidateStreets)) {
        for (let i = 1; i < road.length - 1; i++) {
          const p = road[i], key = pointKey(p), index = gridIndex.get(key)
          if (index === undefined || !allowed(p) || (!junctions.has(key) && !fits(p))) continue
          const withJunction = new Map(junctions).set(key, p)
          if (!roundaboutRoutes(streets, withJunction)(connectedTo, key)) continue
          destinations.set(index, p)
          const used = arms.get(index) ?? new Set<string>()
          used.add(pointKey(road[i - 1]))
          used.add(pointKey(road[i + 1]))
          arms.set(index, used)
        }
      }
      const arrival = (index: number, previous: Vector3) => !arms.get(index)?.has(pointKey(previous))
      const departure = (_index: number, next: Vector3) => from !== target || goesInward(next)
      const branch = pathBetween(ports, destinations, allowed, arrival, departure, true) ??
        pathBetween(ports, destinations, allowed, arrival, departure)
      if (!branch) return
      const junction = branch[branch.length - 1]
      return { from, junction, branch }
    }
    const paveBranch = ({ from, junction, branch }: NonNullable<ReturnType<typeof planBranch>>) => {
      const key = pointKey(junction)
      roundabouts = new Map(roundabouts).set(key, junction)
      pave(from, key, branch, district.name)
    }
    const routeWithBranches = () => roundaboutRoutes(streetsIn(district), roundabouts)(building, target)
    const targetPorts = gateway ? singleton(gateway.point) : lotPorts.get(target)
    const buildingPorts = lotPorts.get(building)
    const merge = planBranch(target, targetPorts, building) ?? planBranch(building, buildingPorts, target)
    if (merge) {
      paveBranch(merge)
      return routeWithBranches()
    }
    // If neither endpoint is on the local network yet, see whether two short spurs can share a street.
    const anchors = new Set(Object.keys(localRoads).flatMap((id) => id.split('>')).filter((id) => layout.lots[id]))
    for (const anchor of anchors) {
      const first = planBranch(building, buildingPorts, anchor)
      if (!first) continue
      const junction = pointKey(first.junction)
      const staged = { ...localRoads, [streetKey(building, junction)]: building < junction ? first.branch : [...first.branch].reverse() }
      reserve(first.branch)
      const second = planBranch(target, targetPorts, building, staged,
        new Map(roundabouts).set(junction, first.junction), localRoads)
      restoreReservations()
      if (!second) continue
      paveBranch(first)
      paveBranch(second)
      return routeWithBranches()
    }
    const direct = pathBetween(buildingPorts, targetPorts, allowed, (_index, previous) => goesInward(previous))
    if (direct) pave(building, target, direct, district.name)
    return direct
  }

  for (const { from, to } of calls) {
    const key = streetKey(from, to)
    if (routes[key] || from === to) continue
    const first = districtByName.get(namespaceOf(from)), second = districtByName.get(namespaceOf(to))
    if (!first || !second || !lotPorts.has(from) || !lotPorts.has(to)) continue
    if (first === second) {
      // Resolve and commit a route before considering the next call, even within one batch.
      const route = connectLocal(from, to, first)
      if (!route) continue
      routes[key] = from < to ? route : [...route].reverse()
      continue
    }
    const districtPair = streetKey(first.name, second.name)
    const alreadyPaved = gatewayPaths.has(districtPair)
    const before = new Set(Object.keys(roads))
    const priorRoundabouts = roundabouts
    const highway = highwayBetween(first, second)
    if (!highway) continue
    const fromLeft = first === highway.left
    const travel = fromLeft ? highway.path : [...highway.path].reverse()
    const exit = connectLocal(from, fromLeft ? highway.start : highway.end, first, { point: travel[0], inward: fromLeft ? -1 : 1 })
    const entry = connectLocal(to, fromLeft ? highway.end : highway.start, second,
      { point: travel[travel.length - 1], inward: fromLeft ? 1 : -1 })
    if (!exit || !entry) {
      for (const key of Object.keys(roads)) {
        if (before.has(key)) continue
        delete roads[key]
        districtsByRoad.delete(key)
        highways.delete(key)
      }
      if (!alreadyPaved) gatewayPaths.delete(districtPair)
      roundabouts = priorRoundabouts
      restoreReservations()
      continue
    }
    const route = [...exit.slice(0, -1), ...travel, ...[...entry].reverse().slice(1)]
    routes[key] = from < to ? route : route.reverse()
  }
  return { roads, routes, roundabouts, highways }
}
