import * as THREE from 'three'

/** Port Kube is a grid of square lots; Streets run along every lot boundary. */
export const LOT = 14
export const STREET_W = 3
export const DRIVEWAY_X = 4.5 // lot-local x of each Building's driveway (Units sit to its left)
const LANE = 0.6
const RING_SIDE = 1  // Scenery columns either side of the service districts
const RING_BACK = 2  // downtown rows behind
const RING_FRONT = 1 // row in front (Power Stations and suburbs)

export interface Lot { key: string; col: number; row: number; center: THREE.Vector3 }
export type SceneryZone = 'downtown' | 'midrise' | 'suburb' | 'park'
export interface SceneryLot { col: number; row: number; center: THREE.Vector3; zone: SceneryZone }
export interface District { name: string; x0: number; x1: number; z0: number; z1: number }
export interface CityLayout {
  lots: Record<string, Lot>          // service lots by "ns/name"
  stations: Record<string, Lot>      // Power Station lots by node name
  scenery: SceneryLot[]
  districts: District[]
  streetsX: number[]
  streetsZ: number[]
  extent: { x0: number; x1: number; z0: number; z1: number }
  focus: THREE.Vector3               // centre of the service districts
}

/** Service districts in the middle, ringed by Scenery and Power Stations. Pure and deterministic. */
export function layoutCity(deployments: { namespace: string; name: string }[], nodes: string[]): CityLayout {
  const namespaces = [...new Set(deployments.map((d) => d.namespace))].sort()
  const lots: CityLayout['lots'] = {}
  const raw: { name: string; c0: number; c1: number; rows: number }[] = []
  let svcCols = 0, svcRows = 1
  for (const ns of namespaces) {
    const deps = deployments.filter((d) => d.namespace === ns).sort((a, b) => a.name.localeCompare(b.name))
    const cols = Math.min(2, deps.length)
    const rows = Math.ceil(deps.length / cols)
    deps.forEach((d, i) => {
      const c = RING_SIDE + svcCols + (i % cols), r = RING_BACK + Math.floor(i / cols)
      lots[`${ns}/${d.name}`] = { key: `${ns}/${d.name}`, col: c, row: r, center: new THREE.Vector3() }
    })
    raw.push({ name: ns, c0: RING_SIDE + svcCols, c1: RING_SIDE + svcCols + cols, rows })
    svcCols += cols
    svcRows = Math.max(svcRows, rows)
  }
  const cols = svcCols + 2 * RING_SIDE, rows = svcRows + RING_BACK + RING_FRONT
  const ox = (cols * LOT) / 2, oz = (rows * LOT) / 2
  const centre = (c: number, r: number) => new THREE.Vector3((c + 0.5) * LOT - ox, 0, (r + 0.5) * LOT - oz)
  for (const lot of Object.values(lots)) lot.center.copy(centre(lot.col, lot.row))

  // Power Stations along the front row, starting under the service districts.
  const front = rows - 1
  const stations: CityLayout['stations'] = {}
  ;[...nodes].sort().forEach((n, i) => {
    const c = Math.min(cols - 1, RING_SIDE + i)
    stations[n] = { key: n, col: c, row: front, center: centre(c, front) }
  })

  const taken = new Set([...Object.values(lots), ...Object.values(stations)].map((l) => `${l.col},${l.row}`))
  const scenery: SceneryLot[] = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (taken.has(`${c},${r}`)) continue
      const inServiceArea = r >= RING_BACK && r < RING_BACK + svcRows && c >= RING_SIDE && c < RING_SIDE + svcCols
      const zone: SceneryZone = inServiceArea ? 'park' : r < RING_BACK ? 'downtown' : r === front ? 'suburb' : 'midrise'
      scenery.push({ col: c, row: r, center: centre(c, r), zone })
    }
  }

  return {
    lots, stations, scenery,
    districts: raw.map((d) => ({
      name: d.name, x0: d.c0 * LOT - ox, x1: d.c1 * LOT - ox, z0: RING_BACK * LOT - oz, z1: (RING_BACK + d.rows) * LOT - oz,
    })),
    streetsX: Array.from({ length: cols + 1 }, (_, i) => i * LOT - ox),
    streetsZ: Array.from({ length: rows + 1 }, (_, i) => i * LOT - oz),
    extent: { x0: -ox, x1: ox, z0: -oz, z1: oz },
    focus: new THREE.Vector3(
      (RING_SIDE + svcCols / 2) * LOT - ox, 0, (RING_BACK + svcRows / 2) * LOT - oz),
  }
}

/** Street-following route between two lots' driveways (centre-line, before lane offset). */
export function routeBetween(layout: CityLayout, from: string, to: string): THREE.Vector3[] {
  const a = layout.lots[from], b = layout.lots[to]
  const front = (lot: Lot) => lot.center.z + LOT / 2         // the street in front of the lot
  const drive = (lot: Lot) => lot.center.x + DRIVEWAY_X
  const door = (lot: Lot) => new THREE.Vector3(drive(lot), 0, front(lot) - STREET_W)
  // Pick the north-south street to cross on: just right of the source unless going left.
  const vx = b.col < a.col ? a.center.x - LOT / 2 : a.center.x + LOT / 2
  const pts = [
    door(a),
    new THREE.Vector3(drive(a), 0, front(a)),
    new THREE.Vector3(vx, 0, front(a)),
    new THREE.Vector3(vx, 0, front(b)),
    new THREE.Vector3(drive(b), 0, front(b)),
    door(b),
  ]
  // Drop zero-length legs (e.g. both lots on the same row).
  return pts.filter((p, i) => i === 0 || p.distanceTo(pts[i - 1]) > 1e-6)
}

/** Shift a polyline to its right-hand lane (90° corners only). */
export function laneOffset(pts: THREE.Vector3[], d = LANE): THREE.Vector3[] {
  const right = (p: THREE.Vector3, q: THREE.Vector3) => {
    const dir = q.clone().sub(p).normalize()
    return new THREE.Vector3(-dir.z, 0, dir.x)
  }
  return pts.map((p, i) => {
    const n = new THREE.Vector3()
    if (i > 0) n.add(right(pts[i - 1], p))
    if (i < pts.length - 1) n.add(right(p, pts[i + 1]))
    // At a 90° corner the summed normals (length √2) are exactly the miter; otherwise use the unit normal.
    if (n.length() > 1.5 || i === 0 || i === pts.length - 1) n.normalize()
    return p.clone().addScaledVector(n, d)
  })
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

/** Dev self-check: every route leg is axis-aligned, and all but the driveways lie on a Street line. */
export function checkRoutes(layout: CityLayout, routes: THREE.Vector3[][]) {
  const onLine = (v: number, lines: number[]) => lines.some((l) => Math.abs(l - v) < 1e-6)
  for (const r of routes) {
    for (let i = 1; i < r.length; i++) {
      const a = r[i - 1], b = r[i]
      console.assert(Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.z - b.z) < 1e-6, 'route leg not axis-aligned', r)
      const driveway = i === 1 || i === r.length - 1
      if (!driveway) {
        const ok = Math.abs(a.x - b.x) < 1e-6 ? onLine(a.x, layout.streetsX) : onLine(a.z, layout.streetsZ)
        console.assert(ok, 'route leg leaves the street grid', r)
      }
    }
  }
}
