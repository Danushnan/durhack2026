import * as THREE from 'three'
import type { StreetRoute } from './streetNetwork.ts'

/**
 * Buildings are placed by the call graph, staggered by name, with one District per namespace.
 * Shared streets are routed after the lots are positioned.
 */
const COL = 34            // x distance between call-graph columns
const ROW = 28            // z distance between Buildings in a column
const PAD = 11            // District padding around its Buildings
const DISTRICT_GAP = 16    // room for a row of Scenery between Districts
export const STREET_GRID = 8
export const ROAD_W = 3.2       // two lanes: requests go out on the right, failed ones come back on the left
export const KERB = 0.7         // pavement on each side of a Road
/** Room a Building can take at its largest size (10 replicas), Building-local, including its Unit rows. */
export const BUILDING = { halfW: 7, back: -7.6, front: 6.8 }

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
    gates: Object.fromEntries(gatePos.map(({ key, at }) => {
      const center = at.clone().sub(off)
      center.z = Math.round(center.z / STREET_GRID) * STREET_GRID
      return [key, { key, center }]
    })),
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

/** Shift a polyline sideways (positive = to the right of travel). */
export function offsetPath(pts: THREE.Vector3[], d: number): THREE.Vector3[] {
  return pts.map((p, i) => {
    const dir = pts[Math.min(i + 1, pts.length - 1)].clone().sub(pts[Math.max(i - 1, 0)]).normalize()
    return new THREE.Vector3(p.x - dir.z * d, p.y, p.z + dir.x * d)
  })
}

/** A Car's full trip: out along the right lane, and for a failed request a U-turn and back along the other lane. */
export function carTrip(road: THREE.Vector3[], turnBack: boolean, inbound = [...road].reverse()): THREE.Vector3[] {
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
  return [...out.slice(0, -1), ...arc, ...offsetPath(inbound, lane).slice(1)]
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

/** Check that request paths stay clear of other Buildings. */
export function checkRoads(layout: CityLayout, routes: Record<string, StreetRoute>) {
  for (const [key, { outbound, inbound }] of Object.entries(routes)) {
    const [from, to] = key.split('>')
    for (const lot of Object.values(layout.lots)) {
      if (lot.key === from || lot.key === to) continue
      const hit = [...outbound, ...inbound].find((p) => inBuilding(p, lot.center, ROAD_W / 2))
      console.assert(!hit, `road ${key} crosses ${lot.key}`, hit)
    }
  }
}
