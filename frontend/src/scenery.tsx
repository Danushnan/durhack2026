import { memo, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { type CityLayout, LOT, STREET_W, type SceneryLot } from './layout'
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

interface Box { x: number; y: number; z: number; w: number; h: number; d: number; tone: number }
interface Item { x: number; y: number; z: number; s: number; tone: number }
export interface SceneryModel { bodies: Box[]; bands: Box[]; caps: Box[]; roofs: Item[]; trees: Item[]; parks: Box[]; ponds: Item[] }

/** Lay out every Scenery lot: skyscrapers downtown, mid-rise at the sides, houses and parks at the edges. */
export function buildScenery(layout: CityLayout): SceneryModel {
  const m: SceneryModel = { bodies: [], bands: [], caps: [], roofs: [], trees: [], parks: [], ponds: [] }
  const inner = LOT - STREET_W
  const midX = (layout.extent.x0 + layout.extent.x1) / 2
  layout.scenery.forEach((lot: SceneryLot, i) => {
    const r = rng(1000 + i * 7919)
    const { x: cx, z: cz } = lot.center
    if (lot.zone === 'park') return addPark(m, cx, cz, inner, r)
    if (lot.zone === 'suburb') {
      // two rows of three houses, plus trees between them
      for (let k = 0; k < 6; k++) {
        const x = cx - inner / 3 + (k % 3) * (inner / 3), z = cz - 2.4 + Math.floor(k / 3) * 4.8
        const w = 2.4 + r() * 0.8, h = 1.6 + r() * 0.8
        m.bodies.push({ x, y: h / 2, z, w, h, d: w, tone: r() })
        m.roofs.push({ x, y: h + 0.45 * w, z, s: w, tone: r() })
        m.trees.push({ x: x + 1.9, y: 0, z: z + 1.7, s: 0.7 + r() * 0.5, tone: r() })
      }
      return
    }
    // downtown: tall towers, taller towards the middle of the skyline; midrise: shorter blocks
    const downtown = lot.zone === 'downtown'
    const centrality = 1 - Math.min(1, Math.abs(cx - midX) / (layout.extent.x1 - midX))
    for (let k = 0; k < 4; k++) {
      const x = cx - inner / 4 + (k % 2) * (inner / 2), z = cz - inner / 4 + Math.floor(k / 2) * (inner / 2)
      const w = 3.4 + r() * 1.4, d = 3.4 + r() * 1.4
      const h = downtown ? 10 + r() * 14 + centrality * 12 : 4.5 + r() * 6
      addTower(m, x, z, w, d, h, r)
      if (downtown && r() > 0.5) addTower(m, x, z, w * 0.6, d * 0.6, h * 0.25, r, h) // setback crown
    }
  })
  return m
}

function addTower(m: SceneryModel, x: number, z: number, w: number, d: number, h: number, r: () => number, base = 0) {
  const tone = r()
  m.bodies.push({ x, y: base + h / 2, z, w, h, d, tone })
  for (let y = base + 1.1; y < base + h - 0.6; y += 1.25) {
    m.bands.push({ x, y, z, w: w + 0.06, h: 0.55, d: d + 0.06, tone: r() })
  }
  m.caps.push({ x, y: base + h + 0.12, z, w: w + 0.2, h: 0.24, d: d + 0.2, tone })
  if (h > 22) m.caps.push({ x, y: base + h + 1.6, z, w: 0.12, h: 3, d: 0.12, tone }) // antenna
}

function addPark(m: SceneryModel, cx: number, cz: number, inner: number, r: () => number) {
  m.parks.push({ x: cx, y: 0.03, z: cz, w: inner, h: 0.06, d: inner, tone: 0 })
  m.ponds.push({ x: cx + (r() - 0.5) * 3, y: 0.07, z: cz + (r() - 0.5) * 3, s: 2 + r(), tone: 0 })
  for (let k = 0; k < 12; k++) {
    const x = cx + (r() - 0.5) * (inner - 1.5), z = cz + (r() - 0.5) * (inner - 1.5)
    m.trees.push({ x, y: 0, z, s: 0.8 + r() * 0.7, tone: r() })
  }
}

// ---------- rendering: one InstancedMesh per kind of part ----------

const unitBox = new THREE.BoxGeometry(1, 1, 1)
const pyramid = new THREE.ConeGeometry(0.75, 0.9, 4).rotateY(Math.PI / 4)
const crown = new THREE.ConeGeometry(1, 2, 7)
const trunk = new THREE.CylinderGeometry(0.12, 0.15, 0.8, 6)
const TRUNK = ['#7c4a2d']
const disc = new THREE.CylinderGeometry(1, 1, 0.04, 24)

function Instanced({ geometry, items, material, palette, scaleOf, castShadow = true }: {
  geometry: THREE.BufferGeometry; items: (Box | Item)[]; material: THREE.Material
  palette: string[]; scaleOf: (it: Box | Item) => [number, number, number]; castShadow?: boolean
}) {
  const ref = useRef<THREE.InstancedMesh>(null)
  useLayoutEffect(() => {
    const mesh = ref.current
    if (!mesh) return
    const mtx = new THREE.Matrix4(), col = new THREE.Color()
    items.forEach((it, i) => {
      mtx.compose(new THREE.Vector3(it.x, it.y, it.z), new THREE.Quaternion(), new THREE.Vector3(...scaleOf(it)))
      mesh.setMatrixAt(i, mtx)
      mesh.setColorAt(i, col.set(palette[Math.floor(it.tone * palette.length) % palette.length]))
    })
    mesh.instanceMatrix.needsUpdate = true
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
  }, [items, palette, scaleOf])
  return <instancedMesh ref={ref} args={[geometry, material, items.length]} castShadow={castShadow} receiveShadow />
}

const boxScale = (it: Box | Item): [number, number, number] => {
  const b = it as Box
  return [b.w, b.h, b.d]
}
const itemScale = (it: Box | Item): [number, number, number] => {
  const s = (it as Item).s
  return [s, s, s]
}

// memo: the city re-renders on every watch batch; Scenery only depends on layout and theme.
export const Scenery = memo(function Scenery({ layout, theme }: { layout: CityLayout; theme: Theme }) {
  const model = useMemo(() => buildScenery(layout), [layout])
  const night = theme.mode === 'night'
  const mats = useMemo(() => ({
    body: new THREE.MeshStandardMaterial({ roughness: 0.9 }),
    // Lit windows at night ignore lighting so they glow; by day they are reflective glass.
    band: night ? new THREE.MeshBasicMaterial({ toneMapped: false }) : new THREE.MeshStandardMaterial({ roughness: 0.2, metalness: 0.4 }),
    cap: new THREE.MeshStandardMaterial({ roughness: 0.8 }),
    roof: new THREE.MeshStandardMaterial({ roughness: 0.8 }),
    tree: new THREE.MeshStandardMaterial({ roughness: 1 }),
    trunk: new THREE.MeshStandardMaterial({ color: '#7c4a2d' }),
    park: new THREE.MeshStandardMaterial({ roughness: 1 }),
    pond: new THREE.MeshStandardMaterial({ roughness: 0.1, metalness: 0.2 }),
  }), [night])
  useLayoutEffect(() => () => Object.values(mats).forEach((m) => m.dispose()), [mats])

  // Muted palettes keep Scenery in the background so the real services stand out.
  const P = useMemo(() => night
    ? { body: ['#1c2536', '#222c40', '#1a2130', '#252f45'], band: ['#fcd34d', '#fde68a', '#1e293b', '#f59e0b', '#334155', '#fef3c7'],
        cap: ['#111827'], roof: ['#4b2e2e', '#3f3a52'], tree: ['#14532d', '#166534'], park: ['#0f2a1c'], pond: ['#0c2a4a'] }
    : { body: ['#d6d3d1', '#cbd5e1', '#e7e5e4', '#c4ccd6', '#d4d4d8'], band: ['#93b4d0', '#a5c0d8', '#86a8c6'],
        cap: ['#9ca3af'], roof: ['#b45346', '#9a5b4f', '#6b7280'], tree: ['#3f8f3a', '#4ea345', '#2f7d32'], park: ['#8cc97a'], pond: ['#5fa8d3'] }, [night])
  const trunks = useMemo(() => model.trees.map((t) => ({ ...t, y: 0.4 * t.s })), [model])
  const crowns = useMemo(() => model.trees.map((t) => ({ ...t, y: 0.8 * t.s + 0.9 * t.s })), [model])
  const pondScale = useMemo(() => (it: Box | Item): [number, number, number] => [(it as Item).s, 1, (it as Item).s * 0.7], [])

  return (
    <group>
      <Instanced geometry={unitBox} items={model.parks} material={mats.park} palette={P.park} scaleOf={boxScale} castShadow={false} />
      <Instanced geometry={disc} items={model.ponds} material={mats.pond} palette={P.pond} scaleOf={pondScale} castShadow={false} />
      <Instanced geometry={unitBox} items={model.bodies} material={mats.body} palette={P.body} scaleOf={boxScale} />
      <Instanced geometry={unitBox} items={model.bands} material={mats.band} palette={P.band} scaleOf={boxScale} castShadow={false} />
      <Instanced geometry={unitBox} items={model.caps} material={mats.cap} palette={P.cap} scaleOf={boxScale} />
      <Instanced geometry={pyramid} items={model.roofs} material={mats.roof} palette={P.roof} scaleOf={itemScale} />
      <Instanced geometry={trunk} items={trunks} material={mats.trunk} palette={TRUNK} scaleOf={itemScale} />
      <Instanced geometry={crown} items={crowns} material={mats.tree} palette={P.tree} scaleOf={itemScale} />
    </group>
  )
})
