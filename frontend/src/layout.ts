import * as THREE from 'three'

/**
 * Port Kube has no street grid. Buildings are placed by the call graph (callers on the left, the
 * services they call to the right), staggered by a hash of their name so the town never lines up,
 * each namespace is one rounded District, and a Road exists only where one service calls another.
 */
const COL = 34            // x distance between call-graph columns
const ROW = 28            // z distance between Buildings in a column
const PAD = 11            // District padding around its Buildings
const DISTRICT_GAP = 16    // room for a row of Scenery between Districts
export const ROAD_W = 3.2       // two lanes: requests go out on the right, failed ones come back on the left
export const KERB = 0.7         // pavement on each side of a Road
/** Room a Building can take at its largest size (10 replicas), Building-local, including its Unit rows. */
export const BUILDING = { halfW: 7, back: -7.6, front: 6.8 }
const SIDE_X = BUILDING.halfW + 2.5   // where a Road leaves/enters beside a Building

export interface Lot { key: string; center: THREE.Vector3 }
export interface Rect { x0: number; x1: number; z0: number; z1: number }
export interface District extends Rect { name: string }
export interface CityLayout {
  lots: Record<string, Lot>      // service lots by "ns/name"
  stations: Record<string, Lot>  // Power Station positions by node name
  gates: Record<string, Lot>     // City Gates (Ingresses) by "ingress:ns/name"
  hall: Lot | null               // City Hall: the control plane
  districts: District[]
  core: Rect                     // everything meaningful; Scenery buildings stay outside it
}
export interface Call { from: string; to: string }

/** Stable pseudo-random number in [-1, 1) from a string. */
function hash(s: string, salt = 0) {
  let h = 2166136261 ^ salt
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619)
  return ((h >>> 0) / 4294967296) * 2 - 1
}

/** Pure and deterministic. `calls` must be from→to pairs only (no rates or health) so failures never rearrange the city. */
export function layoutCity(deployments: { namespace: string; name: string }[], nodes: string[], calls: Call[],
  gates: Call[] = []): CityLayout {
  const keys = deployments.map((d) => `${d.namespace}/${d.name}`).sort()
  const known = new Set(keys)
  const edges = calls.filter((c) => known.has(c.from) && known.has(c.to))
  // Depth = longest chain of callers above a service (bounded passes, so a cycle cannot hang it).
  const depth: Record<string, number> = Object.fromEntries(keys.map((k) => [k, 0]))
  for (let pass = 0; pass < keys.length; pass++) {
    for (const e of edges) if (depth[e.to] < depth[e.from] + 1 && depth[e.from] + 1 < keys.length) depth[e.to] = depth[e.from] + 1
  }
  const nsOf = (k: string) => k.split('/')[0]
  const namespaces = [...new Set(keys.map(nsOf))]
  const minDepth = (ns: string) => Math.min(...keys.filter((k) => nsOf(k) === ns).map((k) => depth[k]))
  namespaces.sort((a, b) => minDepth(a) - minDepth(b) || a.localeCompare(b))

  const pos: Record<string, THREE.Vector3> = {}
  const districts: District[] = []
  let x = 0
  namespaces.forEach((ns, d) => {
    const members = keys.filter((k) => nsOf(k) === ns)
    const base = minDepth(ns)
    const cols = Math.max(...members.map((k) => depth[k])) - base + 1
    const shiftZ = d % 2 ? ROW * 0.55 : 0 // neighbouring Districts sit at different depths
    for (let c = 0; c < cols; c++) {
      // Order each column by where its callers sit (barycentre), so Roads do not cross; name breaks ties.
      const callerZ = (k: string) => {
        const zs = edges.filter((e) => e.to === k && pos[e.from]).map((e) => pos[e.from].z)
        return zs.length ? zs.reduce((a, b) => a + b, 0) / zs.length : 0
      }
      const col = members.filter((k) => depth[k] - base === c).sort((a, b) => callerZ(a) - callerZ(b) || a.localeCompare(b))
      // Lean towards the callers (fewer crossings), spread to the minimum gap, then zig-zag a little
      // and jitter by name so chains never form a straight line.
      const ideal = col.map((k) => (c === 0 ? 0 : callerZ(k)))
      const zs: number[] = []
      ideal.forEach((z, i) => zs.push(i === 0 ? z : Math.max(z, zs[i - 1] + ROW)))
      const centre = ideal.reduce((a, b) => a + b, 0) / col.length - zs.reduce((a, b) => a + b, 0) / col.length
      col.forEach((k, i) => {
        const zig = (c % 2 ? 1 : -1) * ROW * 0.22
        pos[k] = new THREE.Vector3(x + PAD + c * COL + hash(k, 1) * 4, 0, zs[i] + centre + zig + shiftZ + hash(k, 2) * 4)
      })
    }
    const xs = members.map((k) => pos[k].x), zs = members.map((k) => pos[k].z)
    const x1 = Math.max(...xs) + PAD
    districts.push({ name: ns, x0: x, x1, z0: Math.min(...zs) - PAD, z1: Math.max(...zs) + PAD })
    x = x1 + DISTRICT_GAP
  })

  // Behind the Districts: City Hall in the middle, Power Stations either side of it.
  const all: Rect = districts.length
    ? { x0: 0, x1: x - DISTRICT_GAP, z0: Math.min(...districts.map((d) => d.z0)), z1: Math.max(...districts.map((d) => d.z1)) }
    : { x0: 0, x1: 0, z0: 0, z1: 0 }
  const sorted = [...nodes].sort()
  const midX = (all.x0 + all.x1) / 2
  const hallPos = new THREE.Vector3(midX, 0, all.z0 - 21)
  const half = Math.ceil(sorted.length / 2)
  const stationPos = sorted.map((_, i) => {
    const left = i < half, k = left ? half - 1 - i : i - half
    return new THREE.Vector3(midX + (left ? -1 : 1) * (20 + k * 18), 0, all.z0 - 17 - k * 3)
  })
  // City Gates: on the western edge, level with the service each one routes customers to.
  const gatePos = gates.filter((g) => pos[g.to]).map((g, i) => ({ key: g.from, at: new THREE.Vector3(all.x0 - 15, 0, pos[g.to].z + i * 12) }))
  const core: Rect = { x0: all.x0 - (gatePos.length ? 24 : 3), x1: all.x1 + 3, z0: all.z0 - 32, z1: all.z1 + 3 }

  // Centre the city on the origin.
  const off = new THREE.Vector3((all.x0 + all.x1) / 2, 0, (all.z0 + all.z1) / 2)
  const moved = (r: Rect) => ({ x0: r.x0 - off.x, x1: r.x1 - off.x, z0: r.z0 - off.z, z1: r.z1 - off.z })
  return {
    lots: Object.fromEntries(keys.map((k) => [k, { key: k, center: pos[k].clone().sub(off) }])),
    stations: Object.fromEntries(sorted.map((n, i) => [n, { key: n, center: stationPos[i].clone().sub(off) }])),
    gates: Object.fromEntries(gatePos.map((g) => [g.key, { key: g.key, center: g.at.clone().sub(off) }])),
    hall: districts.length ? { key: 'city-hall', center: hallPos.clone().sub(off) } : null,
    districts: districts.map((d) => ({ name: d.name, ...moved(d) })),
    core: moved(core),
  }
}

/**
 * The tallest thing that can stand at (x, z) without hiding any `keep` area from the isometric camera,
 * which looks down the (-1, -1, -1) diagonal: a height h hides the ground from (x, z) to (x - h, z - h).
 */
export function heightCap(keep: Rect[], x: number, z: number) {
  let cap = Infinity
  for (const k of keep) {
    const lo = Math.max(x - k.x1, z - k.z1), hi = Math.min(x - k.x0, z - k.z0)
    if (lo <= hi && hi >= 0) cap = Math.min(cap, Math.max(0, lo))
  }
  return cap
}

/** True if a point (with `margin`) is inside the room reserved for a Building. */
function inBuilding(p: THREE.Vector3, c: THREE.Vector3, margin: number) {
  const dx = Math.abs(p.x - c.x), dz = p.z - c.z
  return dx < BUILDING.halfW + margin && dz > BUILDING.back - margin && dz < BUILDING.front + margin
}

/**
 * One Road per call. Each Road has its own lane out of the caller's right side and into the callee's
 * left side (so Roads never share a stretch), joined by a smooth S-curve that bends around any other
 * Building in the way. The Road starts and ends under the two Buildings, so Cars appear from inside.
 */
export function buildRoads(layout: CityLayout, calls: Call[]): Record<string, THREE.Vector3[]> {
  const out: Record<string, THREE.Vector3[]> = {}
  const where = (k: string) => layout.lots[k] ?? layout.gates[k]
  const valid = calls.filter((c) => where(c.from) && layout.lots[c.to])
  // Spread each Building's outgoing (and incoming) Roads along its side, ordered by where they head.
  const slots = (list: Call[], end: 'from' | 'to', other: 'from' | 'to') => {
    const m = new Map<Call, number>()
    const groups = new Map<string, Call[]>()
    for (const c of list) groups.set(c[end], [...(groups.get(c[end]) ?? []), c])
    for (const g of groups.values()) {
      g.sort((a, b) => where(a[other]).center.z - where(b[other]).center.z)
      g.forEach((c, i) => m.set(c, (i - (g.length - 1) / 2) * (ROAD_W + 1.6) - 1))
    }
    return m
  }
  const outZ = slots(valid, 'from', 'to'), inZ = slots(valid, 'to', 'from')
  for (const c of valid) {
    const gate = !!layout.gates[c.from]
    const a = where(c.from).center, b = layout.lots[c.to].center
    const za = gate ? a.z : a.z + outZ.get(c)!, zb = b.z + inZ.get(c)!
    // Customers come from beyond the city edge, through the gate's arch.
    const start = new THREE.Vector3(gate ? a.x - 14 : a.x + 2, 0, za), exit = new THREE.Vector3(a.x + (gate ? 4 : SIDE_X), 0, za)
    const entry = new THREE.Vector3(b.x - SIDE_X, 0, zb), end = new THREE.Vector3(b.x - 2, 0, zb)
    // shortcut: assumes the callee is to the right (true for this layout); a call back to the left loops wide.
    const h = Math.max(6, (entry.x - exit.x) / 2)
    const others = Object.values(layout.lots).filter((l) => l.key !== c.from && l.key !== c.to)
    let best: THREE.Vector3[] = []
    // Straight if possible, else bend out further and further (a call that skips columns may need a wide detour).
    for (const bend of [0, ...Array.from({ length: 10 }, (_, i) => [9 * (i + 1), -9 * (i + 1)]).flat()]) {
      const curve = new THREE.CubicBezierCurve3(exit, new THREE.Vector3(exit.x + h, 0, exit.z + bend),
        new THREE.Vector3(entry.x - h, 0, entry.z + bend), entry)
      const pts = [start, ...curve.getPoints(40), end]
      if (!best.length) best = pts
      if (pts.every((p) => others.every((l) => !inBuilding(p, l.center, ROAD_W)))) { best = pts; break }
    }
    out[`${c.from}>${c.to}`] = best
  }
  return out
}

// Find crossings between distinct routes in the ground plane.
export function roadJunctions(roads: Record<string, THREE.Vector3[]>): THREE.Vector3[] {
  const paths = Object.values(roads)
  const junctions: THREE.Vector3[] = []
  for (const [index, path] of paths.entries()) {
    for (const other of paths.slice(index + 1)) {
      for (let i = 1; i < path.length; i++) {
        const a = path[i - 1], b = path[i]
        const dx = b.x - a.x, dz = b.z - a.z
        for (let j = 1; j < other.length; j++) {
          const c = other[j - 1], d = other[j]
          const ex = d.x - c.x, ez = d.z - c.z
          const cross = dx * ez - dz * ex
          // Nearly parallel roads do not form a crossing.
          if (Math.abs(cross) <= 0.2 * Math.hypot(dx, dz) * Math.hypot(ex, ez)) continue
          const x = c.x - a.x, z = c.z - a.z
          const t = (x * ez - z * ex) / cross
          const u = (x * dz - z * dx) / cross
          if (t < 0 || t > 1 || u < 0 || u > 1) continue
          const point = a.clone().lerp(b, t)
          if (!junctions.some((existing) => existing.distanceToSquared(point) < ROAD_W ** 2)) {
            junctions.push(point)
          }
        }
      }
    }
  }
  return junctions
}

/** Shift a polyline sideways (positive = to the right of travel). */
export function offsetPath(pts: THREE.Vector3[], d: number): THREE.Vector3[] {
  return pts.map((p, i) => {
    const dir = pts[Math.min(i + 1, pts.length - 1)].clone().sub(pts[Math.max(i - 1, 0)]).normalize()
    return new THREE.Vector3(p.x - dir.z * d, p.y, p.z + dir.x * d)
  })
}

/** A Car's full trip: out along the right lane, and for a failed request a U-turn and back along the other lane. */
export function carTrip(road: THREE.Vector3[], turnBack: boolean): THREE.Vector3[] {
  const lane = ROAD_W / 4
  const out = offsetPath(road, lane)
  if (!turnBack) return out
  const n = road.length
  const c = road[n - 1], dir = c.clone().sub(road[n - 2]).normalize()
  const right = new THREE.Vector3(-dir.z, 0, dir.x)
  const arc = Array.from({ length: 9 }, (_, i) => {
    const t = (i / 8) * Math.PI
    return c.clone().addScaledVector(right, lane * Math.cos(t)).addScaledVector(dir, lane * 1.6 * Math.sin(t))
  })
  return [...out.slice(0, -1), ...arc, ...offsetPath([...road].reverse(), lane).slice(1)]
}

/** A polyline you can sample by distance travelled. */
export class Path {
  readonly lengths: number[] = [0]
  readonly pts: THREE.Vector3[]
  constructor(pts: THREE.Vector3[]) {
    this.pts = pts
    for (let i = 1; i < pts.length; i++) this.lengths.push(this.lengths[i - 1] + pts[i].distanceTo(pts[i - 1]))
  }
  get length() { return this.lengths[this.lengths.length - 1] }
  /** Writes the position into `out` and returns the heading (radians about y). */
  at(s: number, out: THREE.Vector3): number {
    s = Math.max(0, Math.min(this.length, s))
    let i = 1
    while (i < this.pts.length - 1 && this.lengths[i] < s) i++
    const a = this.pts[i - 1], b = this.pts[i]
    const seg = this.lengths[i] - this.lengths[i - 1] || 1
    out.lerpVectors(a, b, (s - this.lengths[i - 1]) / seg)
    return Math.atan2(-(b.z - a.z), b.x - a.x)
  }
}

/** Dev self-check: no Road runs through another Building's reserved room; logs Road–Road crossings too. */
export function checkRoads(layout: CityLayout, roads: Record<string, THREE.Vector3[]>) {
  for (const [key, road] of Object.entries(roads)) {
    const [from, to] = key.split('>')
    for (const lot of Object.values(layout.lots)) {
      if (lot.key === from || lot.key === to) continue
      const hit = road.find((p) => inBuilding(p, lot.center, ROAD_W / 2))
      console.assert(!hit, `road ${key} crosses ${lot.key}`, hit)
    }
  }
  const segs = Object.entries(roads).flatMap(([k, r]) => r.slice(1).map((p, i) => ({ k, a: r[i], b: p })))
  const cross = (s: typeof segs[0], t: typeof segs[0]) => {
    const d = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3) => (q.x - p.x) * (r.z - p.z) - (q.z - p.z) * (r.x - p.x)
    return d(s.a, s.b, t.a) * d(s.a, s.b, t.b) < 0 && d(t.a, t.b, s.a) * d(t.a, t.b, s.b) < 0
  }
  let crossings = 0
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j < segs.length; j++) if (segs[i].k !== segs[j].k && cross(segs[i], segs[j])) crossings++
  if (crossings) console.info(`roads: ${crossings} road-road crossing(s)`)
}
