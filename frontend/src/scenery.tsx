import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { type District, heightCap, type Rect } from './layout'
import type { Theme } from './theme'

/** Deterministic RNG so Port Kube looks the same on every load. */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Part { x: number; y: number; z: number; w: number; h: number; d: number; rot: number; tone: number }
export interface Obstacle { x: number; z: number; rad: number }
type Kind = 'walls' | 'glass' | 'rounds' | 'bands' | 'rings' | 'caps' | 'roofs' | 'trunks' | 'crowns' | 'ponds' | 'gables'
export type SceneryModel = Record<Kind, Part[]>

/** How far a point is outside a rectangle (0 when inside). */
const outside = (r: Rect, x: number, z: number) =>
  Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.z0 - z, 0, z - r.z1))
const inAny = (ds: District[], x: number, z: number, m: number) => ds.some((d) => x > d.x0 - m && x < d.x1 + m && z > d.z0 - m && z < d.z1 + m)

/**
 * Scatter decorative Scenery around the city: a ring of houses, shops and apartment blocks lining every
 * District (so the services sit in a neighbourhood), a varied skyline further out (box, round and stepped
 * towers in mixed colours) that rises with distance, warehouses, and trees and ponds wherever there is
 * room. Nothing is taller than `heightCap` allows, so no Scenery ever hides a service (`keep`).
 */
export function buildScenery(core: Rect, districts: District[], obstacles: Obstacle[], keep: Rect[]): SceneryModel {
  const m: SceneryModel = { walls: [], glass: [], rounds: [], bands: [], rings: [], caps: [], roofs: [], trunks: [], crowns: [], ponds: [], gables: [] }
  const r = rng(20261114)
  const solids: Obstacle[] = [...obstacles]
  const free = (x: number, z: number, rad: number) => solids.every((s) => Math.hypot(s.x - x, s.z - z) > s.rad + rad)
  // Also keep the camera's side of the city (in front of its centre line, looking down the diagonal) low-rise.
  const cx = (core.x0 + core.x1) / 2, cz = (core.z0 + core.z1) / 2
  const cap = (x: number, z: number) => Math.min(heightCap(keep, x, z) - 0.5, x - cx + z - cz > 0 ? 9 : Infinity)
  const sample = (reach: number) => ({
    x: core.x0 - reach + r() * (core.x1 - core.x0 + 2 * reach),
    z: core.z0 - reach + r() * (core.z1 - core.z0 + 2 * reach),
  })
  const rot = () => (r() - 0.5) * 0.6
  const boxTower = (list: Part[], x: number, z: number, w: number, d: number, h: number, a: number, base = 0) => {
    const tone = r()
    list.push({ x, y: base + h / 2, z, w, h, d, rot: a, tone })
    for (let y = base + 1.3; y < base + h - 0.8; y += 1.7) m.bands.push({ x, y, z, w: w + 0.05, h: 0.5, d: d + 0.05, rot: a, tone: r() })
    m.caps.push({ x, y: base + h + 0.15, z, w: w * 0.75, h: 0.4, d: d * 0.75, rot: a, tone })
  }

  // The neighbourhood: buildings lining each District's edge, facing it. Low in front (the camera's side),
  // taller behind, where they cannot hide anything.
  for (const dist of districts) {
    const ring = { x0: dist.x0 - 5.5, x1: dist.x1 + 5.5, z0: dist.z0 - 5.5, z1: dist.z1 + 5.5 }
    const w = ring.x1 - ring.x0, d = ring.z1 - ring.z0
    for (let u = r() * 3; u < 2 * (w + d); u += 6 + r() * 1.5) {
      // Walk the perimeter: top edge, right, bottom, left. `a` turns each building to face the District.
      const [x, z, a] = u < w ? [ring.x0 + u, ring.z0, 0] : u < w + d ? [ring.x1, ring.z0 + u - w, Math.PI / 2]
        : u < 2 * w + d ? [ring.x1 - (u - w - d), ring.z1, 0] : [ring.x0, ring.z1 - (u - 2 * w - d), Math.PI / 2]
      const top = cap(x, z), jitter = (r() - 0.5) * 0.12
      if (top < 2.6 || inAny(districts, x, z, 2.5) || !free(x, z, 2.9)) continue
      solids.push({ x, z, rad: 2.9 })
      const style = r()
      if (top > 9 && style < 0.55) {
        // apartment block
        boxTower(r() < 0.3 ? m.glass : m.walls, x, z, 4.6 + r() * 1.2, 3.6 + r() * 0.8, Math.min(top - 0.5, 6 + r() * 12), a + jitter)
      } else if (top > 4.2 && style < 0.8) {
        // corner shop or terrace: flat roof with a parapet
        const h = 2.6 + r() * Math.min(1.2, top - 4.2)
        m.walls.push({ x, y: h / 2, z, w: 4.4 + r(), h, d: 3.4 + r() * 0.6, rot: a + jitter, tone: r() })
        m.caps.push({ x, y: h + 0.15, z, w: 4.6, h: 0.3, d: 3.6, rot: a + jitter, tone: r() })
      } else {
        // house with a pyramid roof (0.8 × its width tall), sized to fit under the cap
        const s = Math.min(2.4 + r() * 0.8, (top - 1.4) / 0.8), h = 1.4 + r() * 0.6
        if (s < 1.6) continue
        m.walls.push({ x, y: h / 2, z, w: s, h, d: s * (0.9 + r() * 0.3), rot: a + jitter, tone: r() })
        m.roofs.push({ x, y: h + 0.4 * s, z, w: s, h: s, d: s, rot: a + jitter, tone: r() })
      }
    }
  }

  // Skyline: further out, rising with distance, never taller than the height cap allows.
  for (let tries = 0, made = 0; tries < 1400 && made < 64; tries++) {
    const { x, z } = sample(70)
    const dist = outside(core, x, z)
    if (dist < 9 || inAny(districts, x, z, 4) || !free(x, z, 4.8)) continue
    const h = Math.min(34, 5 + dist * 0.34 + r() * 8, cap(x, z))
    if (h < 5) continue
    made++
    const style = r()
    solids.push({ x, z, rad: 4.4 })
    if (style < 0.22) {
      // round tower
      const rad = 2 + r() * 1.2
      m.rounds.push({ x, y: h / 2, z, w: rad, h, d: rad, rot: 0, tone: r() })
      for (let y = 1.3; y < h - 0.8; y += 1.7) m.rings.push({ x, y, z, w: rad + 0.03, h: 0.5, d: rad + 0.03, rot: 0, tone: r() })
      m.caps.push({ x, y: h + 0.3, z, w: rad * 1.1, h: 0.6, d: rad * 1.1, rot: 0, tone: r() })
    } else if (style < 0.45 && h > 14) {
      // stepped tower: three setbacks
      const a = rot(), w = 4.6 + r() * 1.6, d = 4.6 + r() * 1.6
      const h1 = h * 0.5, h2 = h * 0.3, h3 = h * 0.2
      boxTower(m.walls, x, z, w, d, h1, a)
      boxTower(m.walls, x, z, w * 0.75, d * 0.75, h2, a, h1)
      boxTower(m.glass, x, z, w * 0.5, d * 0.5, h3, a, h1 + h2)
      if (h > 26) m.caps.push({ x, y: h + 1.6, z, w: 0.12, h: 3, d: 0.12, rot: a, tone: 0 })
    } else if (style < 0.7) {
      boxTower(r() < 0.5 ? m.glass : m.walls, x, z, 3.6 + r() * 2.4, 3.6 + r() * 2.4, h, rot())
    } else {
      // wide apartment block with a rooftop box
      const a = rot(), hh = Math.min(h, 12)
      boxTower(m.walls, x, z, 6 + r() * 2.5, 3.4 + r(), hh, a)
      m.caps.push({ x: x + 1, y: hh + 0.8, z, w: 1.4, h: 1.2, d: 1.4, rot: a, tone: r() })
    }
  }

  // Warehouses and houses: low, closer in, all around.
  for (let tries = 0, made = 0; tries < 500 && made < 10; tries++) {
    const { x, z } = sample(40)
    const dist = outside(core, x, z)
    if (dist < 5 || dist > 36 || inAny(districts, x, z, 3) || !free(x, z, 5) || cap(x, z) < 4.2) continue
    made++
    const w = 7 + r() * 3, d = 4.5 + r() * 1.5, h = 2.6 + r(), a = r() * Math.PI
    solids.push({ x, z, rad: 5 })
    m.walls.push({ x, y: h / 2, z, w, h, d, rot: a, tone: r() })
    m.gables.push({ x, y: h, z, w, h: 1.4, d: d + 0.2, rot: a, tone: r() })
  }
  for (let tries = 0, made = 0; tries < 600 && made < 28; tries++) {
    const { x, z } = sample(38)
    const dist = outside(core, x, z)
    if (dist < 4 || dist > 34 || inAny(districts, x, z, 2) || !free(x, z, 2.8) || cap(x, z) < 4.6) continue
    made++
    const w = 2.3 + r() * 1.1, h = 1.6 + r() * 0.9, a = r() * Math.PI
    solids.push({ x, z, rad: 2.6 })
    m.walls.push({ x, y: h / 2, z, w, h, d: w * (0.9 + r() * 0.4), rot: a, tone: r() })
    m.roofs.push({ x, y: h + 0.4 * w, z, w, h: w, d: w, rot: a, tone: r() })
  }

  // Ponds, then tree clusters (trees may also stand on Districts, between the services).
  for (let tries = 0, made = 0; tries < 300 && made < 4; tries++) {
    const { x, z } = sample(30)
    const s = 3 + r() * 2.5
    if (outside(core, x, z) < 6 || inAny(districts, x, z, s) || !free(x, z, s)) continue
    solids.push({ x, z, rad: s }); made++
    m.ponds.push({ x, y: 0.03, z, w: s, h: 1, d: s * (0.6 + r() * 0.3), rot: r() * Math.PI, tone: 0 })
  }
  for (let c = 0; c < 80; c++) {
    const centre = sample(50)
    const n = 2 + Math.floor(r() * 5)
    for (let i = 0; i < n; i++) {
      const x = centre.x + (r() - 0.5) * 9, z = centre.z + (r() - 0.5) * 9
      if (!free(x, z, 1.2)) continue
      solids.push({ x, z, rad: 1 })
      const s = 0.7 + r() * 0.7, tone = r()
      m.trunks.push({ x, y: 0.5 * s, z, w: s, h: s, d: s, rot: 0, tone })
      m.crowns.push({ x, y: 1.55 * s, z, w: s, h: s * (0.9 + r() * 0.4), d: s, rot: r() * 3, tone })
    }
  }
  return m
}

// ---------- rendering: one InstancedMesh per kind of part ----------

const unitBox = new THREE.BoxGeometry(1, 1, 1)
const cylinder = new THREE.CylinderGeometry(1, 1, 1, 20)
const pyramid = new THREE.ConeGeometry(0.78, 0.8, 4).rotateY(Math.PI / 4)
const prism = (() => {
  const s = new THREE.Shape()
  s.moveTo(-0.5, 0); s.lineTo(0.5, 0); s.lineTo(0, 1); s.closePath()
  return new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false }).translate(0, 0, -0.5).rotateY(Math.PI / 2)
})()
const crown = new THREE.IcosahedronGeometry(1, 0)
const trunk = new THREE.CylinderGeometry(0.13, 0.17, 1, 6)
const disc = new THREE.CylinderGeometry(1, 1, 0.04, 28)
const Y = new THREE.Vector3(0, 1, 0)
const TRUNK = ['#7c4a2d']

function Instanced({ geometry, items, material, palette, castShadow = true }: {
  geometry: THREE.BufferGeometry; items: Part[]; material: THREE.Material; palette: string[]; castShadow?: boolean
}) {
  const ref = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const mtx = new THREE.Matrix4(), col = new THREE.Color(), q = new THREE.Quaternion()
    items.forEach((it, i) => {
      mtx.compose(new THREE.Vector3(it.x, it.y, it.z), q.setFromAxisAngle(Y, it.rot), new THREE.Vector3(it.w, it.h, it.d))
      mesh.setMatrixAt(i, mtx)
      mesh.setColorAt(i, col.set(palette[Math.floor(it.tone * palette.length) % palette.length]))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [items, palette, material, geometry]) // material: swapping it recreates the mesh, which must be refilled
  return <instancedMesh ref={ref} args={[geometry, material, items.length]} castShadow={castShadow} receiveShadow />
}

// Varied but softer than the landmark accents, so Scenery never competes with the services.
const PALETTES = {
  night: {
    walls: ['#2a3350', '#33304a', '#3a3446', '#263a4a', '#2e3a36', '#3b3340', '#2f3858'],
    glass: ['#1e3a5c', '#1d4250', '#273e66'],
    band: ['#141c30', '#141c30', '#141c30', '#18223b', '#7a6534', '#9a7b3a', '#3f4c70', '#5a6fa0'],
    cap: ['#161e33', '#1d2640'], roof: ['#5a3640', '#3e3a5a', '#4a3a30'], gable: ['#3a4256', '#4a3a3a'],
    tree: ['#1c4a33', '#205a3b', '#184030', '#2a5a2a'], pond: ['#16365e'],
  },
  day: {
    walls: ['#efe6d8', '#e6cfae', '#dba98f', '#cfa08a', '#d9e3ec', '#cfe2d6', '#ddd5ea', '#ece4c4', '#d5d8dc'],
    glass: ['#9fbad3', '#8fb3c4', '#a9bfe0', '#7fa4bf'],
    band: ['#c7d3df', '#cfd9e3', '#bfcddb'],
    cap: ['#b8bec8', '#a9b0bb'], roof: ['#c2675a', '#b0705f', '#8b93a1', '#c98a5a', '#6f8fa8', '#9c6b8f'], gable: ['#9aa3ae', '#b07a5f'],
    tree: ['#5aa650', '#6bb85e', '#4a9547', '#7abf6a', '#8cc46a'], pond: ['#79b8dd'],
  },
}

// memo: the city re-renders on every watch batch; Scenery only depends on the layout and theme.
export const Scenery = memo(function Scenery({ core, districts, obstacles, keep, theme }: {
  core: Rect; districts: District[]; obstacles: Obstacle[]; keep: Rect[]; theme: Theme
}) {
  const model = useMemo(() => buildScenery(core, districts, obstacles, keep), [core, districts, obstacles, keep])
  const night = theme.mode === 'night'
  const mats = useMemo(() => ({
    wall: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    glass: new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0.45 }),
    // At night window bands ignore lighting so the lit ones glow softly; by day they are glass.
    band: night ? new THREE.MeshBasicMaterial({ toneMapped: false }) : new THREE.MeshStandardMaterial({ roughness: 0.25, metalness: 0.3 }),
    cap: new THREE.MeshStandardMaterial({ roughness: 0.8 }),
    roof: new THREE.MeshStandardMaterial({ roughness: 0.8, flatShading: true }),
    tree: new THREE.MeshStandardMaterial({ roughness: 1, flatShading: true }),
    trunk: new THREE.MeshStandardMaterial({ color: '#7c4a2d' }),
    pond: new THREE.MeshStandardMaterial({ roughness: 0.1, metalness: 0.2 }),
  }), [night])
  useLayoutEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats])
  const P = PALETTES[theme.mode]
  return (
    <group>
      <Instanced geometry={disc} items={model.ponds} material={mats.pond} palette={P.pond} castShadow={false} />
      <Instanced geometry={unitBox} items={model.walls} material={mats.wall} palette={P.walls} />
      <Instanced geometry={unitBox} items={model.glass} material={mats.glass} palette={P.glass} />
      <Instanced geometry={cylinder} items={model.rounds} material={mats.wall} palette={P.walls} />
      <Instanced geometry={unitBox} items={model.bands} material={mats.band} palette={P.band} castShadow={false} />
      <Instanced geometry={cylinder} items={model.rings} material={mats.band} palette={P.band} castShadow={false} />
      <Instanced geometry={unitBox} items={model.caps} material={mats.cap} palette={P.cap} />
      <Instanced geometry={pyramid} items={model.roofs} material={mats.roof} palette={P.roof} />
      <Instanced geometry={prism} items={model.gables} material={mats.roof} palette={P.gable} />
      <Instanced geometry={trunk} items={model.trunks} material={mats.trunk} palette={TRUNK} />
      <Instanced geometry={crown} items={model.crowns} material={mats.tree} palette={P.tree} />
    </group>
  )
})
