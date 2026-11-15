import { Instance, Instances } from '@react-three/drei'
import { useEffect, useMemo } from 'react'
import * as THREE from 'three'
import { textTexture } from './textures'
import { canonical } from './teach'
import type { Theme } from './theme'

export type LandmarkKind = 'mall' | 'market' | 'tollgate' | 'bank' | 'archive' | 'kiosk' | 'tower'

export interface LandmarkInfo { kind: LandmarkKind; title: string; sign: string; emoji: string; accent: string; height: number }

const BY_SERVICE: Record<string, LandmarkInfo> = {
  frontend: { kind: 'mall', title: 'Shopping Mall', sign: 'SHOPPING MALL', emoji: '🛍️', accent: '#0ea5e9', height: 5.6 },
  cart: { kind: 'market', title: 'Market Hall', sign: 'MARKET HALL', emoji: '🧺', accent: '#d97706', height: 4.3 },
  checkout: { kind: 'tollgate', title: 'Checkout Plaza', sign: 'CHECKOUT PLAZA', emoji: '🧾', accent: '#7c3aed', height: 4 },
  payments: { kind: 'bank', title: 'Bank', sign: 'BANK', emoji: '🏦', accent: '#059669', height: 7.6 },
  postgres: { kind: 'archive', title: 'Archive', sign: 'ARCHIVE · DATABASE', emoji: '📚', accent: '#db2777', height: 9.3 },
  redis: { kind: 'kiosk', title: 'Kiosk', sign: 'KIOSK · CACHE', emoji: '🏪', accent: '#e11d48', height: 3.4 },
  products: { kind: 'tower', title: 'Catalogue Tower', sign: 'CATALOGUE', emoji: '📦', accent: '#0d9488', height: 9 },
}
const FALLBACK: LandmarkInfo = { kind: 'tower', title: 'Office Tower', sign: 'OFFICES', emoji: '🏢', accent: '#475569', height: 14 }

export const landmarkFor = (service: string) => BY_SERVICE[canonical(service)] ?? FALLBACK

type V3 = [number, number, number]

interface Mats { wall: THREE.Material; trim: THREE.Material; accent: THREE.Material; glass: THREE.Material; window: THREE.Material; lit: THREE.Material; gold: THREE.Material; white: THREE.Material }

function useMats(info: LandmarkInfo, glow: string, theme: Theme): Mats {
  const night = theme.mode === 'night'
  const m = useMemo<Mats>(() => ({
    wall: new THREE.MeshStandardMaterial({ color: night ? '#8593ad' : '#f1ede4', roughness: 0.85 }),
    trim: new THREE.MeshStandardMaterial({ color: night ? '#3d4963' : '#8b8f99', roughness: 0.7 }),
    accent: new THREE.MeshStandardMaterial({ color: info.accent, roughness: 0.5 }),
    glass: new THREE.MeshStandardMaterial({ color: night ? '#38bdf8' : '#9cc7e4', roughness: 0.1, metalness: 0.5, transparent: true, opacity: 0.85,
      emissive: night ? '#0c4a6e' : '#000000' }),
    // At night the windows glow; by day they read as glass.
    window: night ? new THREE.MeshBasicMaterial({ color: '#fde68a', toneMapped: false })
      : new THREE.MeshStandardMaterial({ color: '#7ea6c6', roughness: 0.15, metalness: 0.5 }),
    lit: new THREE.MeshBasicMaterial({ color: glow, toneMapped: false }),
    gold: new THREE.MeshStandardMaterial({ color: '#d4a017', metalness: 0.8, roughness: 0.3 }),
    white: new THREE.MeshStandardMaterial({ color: '#f8fafc' }),
  }), [info.accent, glow, night])
  useEffect(() => () => Object.values(m).forEach((x) => x.dispose()), [m])
  return m
}

const B = (size: V3, pos: V3, mat: THREE.Material, rot?: V3) => (
  <mesh position={pos} rotation={rot} material={mat} castShadow receiveShadow>
    <boxGeometry args={size} />
  </mesh>
)

const Cyl = (r: number, h: number, pos: V3, mat: THREE.Material, rTop = r) => (
  <mesh position={pos} material={mat} castShadow>
    <cylinderGeometry args={[rTop, r, h, 16]} />
  </mesh>
)

/** A grid of window panes on a facade, as one instanced mesh. */
function Windows({ mat, cols, rows, x0, dx, y0, dy, z, w = 0.6, h = 0.8, rotY = 0 }: {
  mat: THREE.Material; cols: number; rows: number; x0: number; dx: number; y0: number; dy: number; z: number
  w?: number; h?: number; rotY?: number
}) {
  return (
    <group rotation-y={rotY}>
      <Instances limit={cols * rows} material={mat}>
        <boxGeometry args={[w, h, 0.06]} />
        {Array.from({ length: cols * rows }, (_, i) => (
          <Instance key={i} position={[x0 + (i % cols) * dx, y0 + Math.floor(i / cols) * dy, z]} />
        ))}
      </Instances>
    </group>
  )
}

function Triangle({ w, h, depth, pos, mat }: { w: number; h: number; depth: number; pos: V3; mat: THREE.Material }) {
  const geo = useMemo(() => {
    const s = new THREE.Shape()
    s.moveTo(-w / 2, 0); s.lineTo(w / 2, 0); s.lineTo(0, h); s.closePath()
    return new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false })
  }, [w, h, depth])
  return <mesh geometry={geo} position={pos} material={mat} castShadow />
}

/** A sign on the facade naming the building type; glows at night. */
export function FacadeSign({ text, width, pos, bg, theme, rotY = 0 }: { text: string; width: number; pos: V3; bg: string; theme: Theme; rotY?: number }) {
  const { texture, aspect } = useMemo(() => textTexture([{ text, px: 64, color: '#ffffff', weight: 800 }], { bg, border: '#ffffff', pad: 22, radius: 10 }), [text, bg])
  useEffect(() => () => texture.dispose(), [texture])
  return (
    <mesh position={pos} rotation-y={rotY}>
      <planeGeometry args={[width, width / aspect]} />
      {theme.mode === 'night'
        ? <meshBasicMaterial map={texture} toneMapped={false} />
        : <meshStandardMaterial map={texture} roughness={0.6} />}
    </mesh>
  )
}

/** Distinct, detailed landmark for a service. Front faces +z. `glow` is the health colour of its neon strip. */
export function Landmark({ info, glow, theme }: { info: LandmarkInfo; glow: string; theme: Theme }) {
  const m = useMats(info, glow, theme)
  const sign = (width: number, pos: V3) => <FacadeSign text={info.sign} width={width} pos={pos} bg={info.accent} theme={theme} />

  switch (info.kind) {
    case 'mall':
      return (
        <group>
          {B([9, 0.2, 5.8], [0, 0.1, -0.5], m.trim)}
          {B([8.6, 2.2, 5], [0, 1.3, -0.6], m.wall)}
          {B([7.8, 1.6, 0.08], [0, 1.1, 1.92], m.glass)}
          {[-3.9, -2.6, -1.3, 1.3, 2.6, 3.9].map((x) => <group key={x}>{B([0.1, 1.7, 0.14], [x, 1.1, 1.96], m.trim)}</group>)}
          {[-2.6, 2.6].map((x) => <group key={x}>{B([2.4, 0.12, 0.9], [x, 2.1, 2.35], m.accent, [0.3, 0, 0])}</group>)}
          {B([8.6, 2, 5], [0, 3.4, -0.6], m.wall)}
          <Windows mat={m.window} cols={10} rows={1} x0={-3.9} dx={0.87} y0={3.4} dy={0} z={1.93} w={0.6} h={1} />
          {B([2.4, 4.4, 1.4], [0, 2.4, 2.2], m.glass)}
          {B([2.6, 0.2, 1.6], [0, 4.7, 2.2], m.accent)}
          {B([1.2, 1.7, 0.05], [0, 0.95, 2.93], m.trim)}
          {B([8.8, 0.25, 5.2], [0, 4.5, -0.6], m.accent)}
          {B([8.8, 0.09, 0.09], [0, 4.66, 2.0], m.lit)}
          {[[-3, -1.6], [-1.8, -2.2], [2.9, -2]].map(([x, z]) => <group key={x}>{B([0.8, 0.5, 0.8], [x, 4.88, z], m.trim)}</group>)}
          {B([0.1, 0.9, 0.1], [-2, 5.1, 1], m.trim)}{B([0.1, 0.9, 0.1], [2, 5.1, 1], m.trim)}
          {sign(5, [0, 5.5, 1])}
        </group>
      )
    case 'market':
      return (
        <group>
          {B([8.4, 0.2, 5.6], [0, 0.1, -0.5], m.trim)}
          {B([8, 2.4, 5], [0, 1.4, -0.6], m.wall)}
          <Windows mat={m.window} cols={6} rows={1} x0={-3.3} dx={1.32} y0={1.5} dy={0} z={1.93} w={0.8} h={1.4} />
          {B([8.4, 0.2, 3.1], [0, 3.34, 0.75], m.accent, [0.5, 0, 0])}
          {B([8.4, 0.2, 3.1], [0, 3.34, -1.95], m.accent, [-0.5, 0, 0])}
          <Triangle w={8} h={1.45} depth={0.05} pos={[0, 2.6, 1.85]} mat={m.wall} />
          {B([8.2, 0.3, 0.5], [0, 4.15, -0.6], m.trim)}
          {B([8.4, 0.09, 0.09], [0, 2.62, 2.05], m.lit)}
          {[-2.8, 0, 2.8].map((x) => (
            <group key={x} position={[x, 0, 2.95]}>
              {B([2, 0.8, 0.8], [0, 0.4, 0], m.trim)}
              {[-0.75, -0.25, 0.25, 0.75].map((sx, i) => <group key={sx}>{B([0.5, 0.08, 1.1], [sx, 1.75, 0.05], i % 2 ? m.white : m.accent, [0.15, 0, 0])}</group>)}
              {Cyl(0.04, 1.75, [-0.95, 0.88, 0.45], m.trim)}{Cyl(0.04, 1.75, [0.95, 0.88, 0.45], m.trim)}
              {(['#dc2626', '#16a34a', '#facc15'] as const).map((c, i) => (
                <mesh key={c} position={[-0.5 + i * 0.5, 0.92, 0]}><sphereGeometry args={[0.16, 10, 8]} /><meshStandardMaterial color={c} /></mesh>
              ))}
            </group>
          ))}
          {sign(3.6, [0, 3.2, 1.93])}
        </group>
      )
    case 'tollgate':
      return (
        <group>
          {B([8, 3, 2.4], [0, 1.5, -2.6], m.wall)}
          <Windows mat={m.window} cols={8} rows={2} x0={-3.4} dx={0.97} y0={1} dy={1.1} z={-1.38} w={0.55} h={0.7} />
          {[-2, 0, 2].map((x) => <group key={x}>{B([0.08, 0.02, 3.4], [x, 0.02, 0.6], m.white)}</group>)}
          {[-3, -1, 1, 3].map((x) => (
            <group key={x}>
              {B([0.9, 1.5, 0.9], [x, 0.75, 0.4], m.wall)}
              {B([0.94, 0.55, 0.94], [x, 1.15, 0.4], m.glass)}
              {B([1.1, 0.12, 1.1], [x, 1.56, 0.4], m.trim)}
              {B([1.0, 0.07, 0.07], [x + 0.55, 0.95, 1.2], m.accent)}
              {B([0.12, 0.25, 0.12], [x - 0.35, 1.9, 0.9], m.lit)}
            </group>
          ))}
          {B([8.6, 0.35, 3.4], [0, 2.9, 0.2], m.accent)}
          {[-4, -1.35, 1.35, 4].flatMap((x) => [-1.2, 1.6].map((z) => <group key={`${x}${z}`}>{Cyl(0.15, 2.75, [x, 1.37, z], m.trim)}</group>))}
          {B([8, 0.06, 0.1], [0, 2.7, 1.6], m.lit)}
          {B([0.1, 0.6, 0.1], [-1.8, 3.35, 1.2], m.trim)}{B([0.1, 0.6, 0.1], [1.8, 3.35, 1.2], m.trim)}
          {sign(5, [0, 3.75, 1.2])}
        </group>
      )
    case 'bank':
      return (
        <group>
          {B([8.4, 0.25, 5.8], [0, 0.125, -0.4], m.trim)}
          {B([7.8, 0.25, 5.4], [0, 0.375, -0.5], m.wall)}
          {B([7.2, 0.25, 5], [0, 0.625, -0.6], m.trim)}
          {B([6.6, 4.2, 3.4], [0, 2.85, -1.3], m.wall)}
          <Windows mat={m.window} cols={4} rows={2} x0={-2.4} dx={1.6} y0={2} dy={1.7} z={0.43} w={0.7} h={1.2} />
          {B([1.1, 1.9, 0.06], [0, 1.7, 0.44], m.gold)}
          {[-3, -1.8, -0.6, 0.6, 1.8, 3].map((x) => (
            <group key={x}>
              {B([0.7, 0.2, 0.7], [x, 0.85, 1.5], m.wall)}
              {Cyl(0.26, 4, [x, 2.95, 1.5], m.wall, 0.22)}
              {B([0.7, 0.2, 0.7], [x, 5.0, 1.5], m.wall)}
            </group>
          ))}
          {B([7.2, 0.6, 4.6], [0, 5.4, -0.7], m.wall)}
          {B([7.2, 0.09, 0.09], [0, 5.08, 1.63], m.lit)}
          <Triangle w={7.2} h={1.4} depth={0.6} pos={[0, 5.7, 1.0]} mat={m.accent} />
          {B([6.8, 0.3, 3.6], [0, 5.85, -1.4], m.accent)}
          {Cyl(0.05, 2.4, [2.8, 7.1, -2], m.trim)}
          {B([0.9, 0.55, 0.03], [3.27, 7.95, -2], m.accent)}
          {sign(2.6, [0, 5.4, 1.62])}
        </group>
      )
    case 'archive':
      return (
        <group>
          {B([6, 0.25, 1.2], [0, 0.125, 1.6], m.trim)}
          {B([7, 5.5, 4.6], [0, 2.75, -1.2], m.wall)}
          <Windows mat={m.window} cols={4} rows={2} x0={-2.4} dx={1.6} y0={1.6} dy={2.2} z={1.13} w={0.9} h={1.8} />
          <Windows mat={m.window} cols={3} rows={2} x0={-0.6} dx={1.6} y0={1.6} dy={2.2} z={3.53} w={0.9} h={1.8} rotY={Math.PI / 2} />
          <Windows mat={m.window} cols={3} rows={2} x0={-2.6} dx={1.6} y0={1.6} dy={2.2} z={3.53} w={0.9} h={1.8} rotY={-Math.PI / 2} />
          {B([1.2, 2, 0.06], [0, 1.25, 1.14], m.trim)}
          {B([7.4, 0.35, 5], [0, 5.68, -1.2], m.accent)}
          {B([7.4, 0.09, 0.09], [0, 5.48, 1.32], m.lit)}
          {Cyl(1.8, 1, [0, 6.35, -1.2], m.wall)}
          <mesh position={[0, 6.85, -1.2]} material={m.accent} castShadow><sphereGeometry args={[1.8, 28, 14, 0, Math.PI * 2, 0, Math.PI / 2]} /></mesh>
          {Cyl(0.35, 0.7, [0, 8.95, -1.2], m.lit)}
          <mesh position={[0, 9.55, -1.2]} material={m.accent}><coneGeometry args={[0.4, 0.6, 12]} /></mesh>
          {sign(4.4, [0, 4.95, 1.14])}
        </group>
      )
    case 'kiosk':
      return (
        <group>
          {B([6.8, 0.15, 4.6], [0, 0.075, -0.6], m.trim)}
          {B([3, 2.2, 2.2], [-0.8, 1.25, -1.2], m.wall)}
          {B([2.2, 0.9, 0.06], [-0.8, 1.5, -0.08], m.glass)}
          {B([2.6, 0.12, 0.5], [-0.8, 1.0, 0.1], m.accent)}
          {B([3.6, 0.2, 2.8], [-0.8, 2.45, -1.0], m.accent, [0.08, 0, 0])}
          {B([3.6, 0.09, 0.09], [-0.8, 2.3, 0.42], m.lit)}
          {[1.9, 2.9].map((x) => (
            <group key={x}>
              {B([0.85, 1.8, 0.7], [x, 1.05, -1.3], m.accent)}
              {B([0.6, 1.2, 0.04], [x, 1.15, -0.93], m.window)}
            </group>
          ))}
          <group position={[1.6, 0, 1.0]}>
            {Cyl(0.5, 0.06, [0, 0.75, 0], m.white)}
            {Cyl(0.05, 1.9, [0, 0.95, 0], m.trim)}
            <mesh position={[0, 1.95, 0]} material={m.accent} castShadow><coneGeometry args={[1.1, 0.45, 8]} /></mesh>
            {[-0.7, 0.7].map((x) => <group key={x}>{Cyl(0.2, 0.45, [x, 0.23, 0], m.trim)}</group>)}
          </group>
          {sign(3, [-0.8, 3.0, -0.3])}
        </group>
      )
    default:
      return (
        <group>
          {B([5, 13, 4.6], [0, 6.5, -1.2], m.wall)}
          <Windows mat={m.window} cols={5} rows={10} x0={-1.9} dx={0.95} y0={2} dy={1.15} z={1.13} />
          {B([3, 1.6, 0.08], [0, 0.85, 1.13], m.glass)}
          {B([5.3, 0.4, 4.9], [0, 13.2, -1.2], m.accent)}
          {B([5.3, 0.09, 0.09], [0, 12.98, 1.3], m.lit)}
          {sign(3, [0, 1.95, 1.14])}
        </group>
      )
  }
}
