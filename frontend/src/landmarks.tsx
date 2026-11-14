import { useMemo } from 'react'
import * as THREE from 'three'
import type { Theme } from './theme'

export type LandmarkKind = 'mall' | 'market' | 'tollgate' | 'bank' | 'archive' | 'kiosk' | 'tower'

export interface LandmarkInfo { kind: LandmarkKind; title: string; emoji: string; accent: string; height: number }

const BY_SERVICE: Record<string, LandmarkInfo> = {
  frontend: { kind: 'mall', title: 'Shopping Mall', emoji: '🛍️', accent: '#38bdf8', height: 3.4 },
  cart: { kind: 'market', title: 'Market Hall', emoji: '🧺', accent: '#f59e0b', height: 3.2 },
  checkout: { kind: 'tollgate', title: 'Checkout Plaza', emoji: '🧾', accent: '#a78bfa', height: 3 },
  payments: { kind: 'bank', title: 'Bank', emoji: '🏦', accent: '#34d399', height: 4 },
  postgres: { kind: 'archive', title: 'Archive', emoji: '📚', accent: '#f472b6', height: 5.8 },
  redis: { kind: 'kiosk', title: 'Kiosk', emoji: '🏪', accent: '#fb7185', height: 3 },
}
const FALLBACK: LandmarkInfo = { kind: 'tower', title: 'Office Tower', emoji: '🏢', accent: '#94a3b8', height: 7 }

export const landmarkFor = (service: string) => BY_SERVICE[service] ?? FALLBACK

type V3 = [number, number, number]

/** Distinct procedural landmark; front faces +z. `glow` is the health colour for windows and signs. */
export function Landmark({ info, glow, theme }: { info: LandmarkInfo; glow: string; theme: Theme }) {
  const wall = <meshStandardMaterial color={theme.wall} roughness={0.8} />
  const accent = <meshStandardMaterial color={info.accent} roughness={0.5} />
  const lit = <meshStandardMaterial color={glow} emissive={glow} emissiveIntensity={theme.glow} />
  const box = (size: V3, pos: V3, mat: React.ReactNode, key?: string | number) => (
    <mesh key={key} position={pos} castShadow>
      <boxGeometry args={size} />
      {mat}
    </mesh>
  )
  const pediment = useMemo(() => {
    const s = new THREE.Shape()
    s.moveTo(-3.1, 0); s.lineTo(3.1, 0); s.lineTo(0, 1.1); s.closePath()
    return new THREE.ExtrudeGeometry(s, { depth: 0.6, bevelEnabled: false })
  }, [])

  switch (info.kind) {
    case 'mall':
      return (
        <group>
          {box([7, 2.6, 4.5], [0, 1.3, 0], wall)}
          {box([6.6, 1.1, 0.1], [0, 1.1, 2.26], lit)}
          {box([4, 0.6, 0.3], [0, 3, 1.6], lit)}
          {box([2.6, 0.15, 1.1], [0, 2.05, 2.7], accent)}
          {box([7.2, 0.25, 4.7], [0, 2.7, 0], accent)}
        </group>
      )
    case 'market':
      return (
        <group>
          {box([6.5, 1.7, 4.4], [0, 0.85, 0], wall)}
          <mesh position={[0, 2.35, 1.05]} rotation-x={-0.55}><boxGeometry args={[7, 0.2, 2.6]} />{accent}</mesh>
          <mesh position={[0, 2.35, -1.05]} rotation-x={0.55}><boxGeometry args={[7, 0.2, 2.6]} />{accent}</mesh>
          {[-2.2, 0, 2.2].map((x, i) => box([1.8, 0.12, 0.9], [x, 1.5, 2.6], i % 2 ? wall : lit, i))}
        </group>
      )
    case 'tollgate':
      return (
        <group>
          {box([7.6, 0.3, 3.6], [0, 2.6, 0], accent)}
          {[[-3.4, -1.4], [3.4, -1.4], [-3.4, 1.4], [3.4, 1.4]].map(([x, z], i) => (
            <mesh key={i} position={[x, 1.25, z]}><cylinderGeometry args={[0.18, 0.18, 2.5, 12]} />{wall}</mesh>
          ))}
          {[-2.3, 0, 2.3].map((x, i) => box([1, 1.4, 1], [x, 0.7, 0], lit, `b${i}`))}
          {[-1.15, 1.15].map((x, i) => box([1.2, 0.1, 0.1], [x, 0.9, 1.5], accent, `a${i}`))}
          {box([3, 0.5, 0.2], [0, 3.05, 1.7], lit)}
        </group>
      )
    case 'bank':
      return (
        <group>
          {box([7, 0.3, 5], [0, 0.15, 0], wall)}
          {box([6.4, 0.3, 4.6], [0, 0.45, 0], wall)}
          {box([5.6, 2.8, 3], [0, 2, -0.7], wall)}
          {[-2.3, -0.77, 0.77, 2.3].map((x, i) => (
            <mesh key={i} position={[x, 1.9, 1.4]}><cylinderGeometry args={[0.28, 0.32, 2.6, 16]} />{wall}</mesh>
          ))}
          {box([6.4, 0.3, 4.2], [0, 3.35, 0], accent)}
          <mesh geometry={pediment} position={[0, 3.5, 1.2]}>{accent}</mesh>
          <mesh position={[0, 1.6, 0.81]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.7, 0.7, 0.08, 24]} />{lit}</mesh>
        </group>
      )
    case 'archive':
      return (
        <group>
          {box([5, 4.2, 4], [0, 2.1, 0], wall)}
          {[1, 2.1, 3.2].map((y) => box([5.05, 0.3, 4.05], [0, y, 0], lit, y))}
          <mesh position={[0, 4.2, 0]}><sphereGeometry args={[1.6, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />{accent}</mesh>
          {box([1.2, 1.4, 0.2], [0, 0.7, 2.05], accent)}
        </group>
      )
    case 'kiosk':
      return (
        <group>
          <mesh position={[0, 0.9, 0]}><cylinderGeometry args={[1.2, 1.2, 1.8, 20]} />{wall}</mesh>
          <mesh position={[0, 1.25, 0]}><cylinderGeometry args={[1.23, 1.23, 0.5, 20]} />{lit}</mesh>
          <mesh position={[0, 2.25, 0]}><coneGeometry args={[1.8, 0.9, 20]} />{accent}</mesh>
          <mesh position={[1.9, 1.3, 0.6]}><cylinderGeometry args={[0.06, 0.06, 2.6, 8]} />{wall}</mesh>
          {box([0.9, 0.6, 0.1], [1.9, 2.7, 0.6], lit)}
        </group>
      )
    default:
      return (
        <group>
          {box([3.6, 7, 3.6], [0, 3.5, 0], wall)}
          {[1, 2.2, 3.4, 4.6, 5.8].map((y) => box([3.65, 0.35, 3.65], [0, y, 0], lit, y))}
          {box([3.8, 0.2, 3.8], [0, 7.1, 0], accent)}
        </group>
      )
  }
}
