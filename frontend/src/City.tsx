import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { Edges, OrbitControls } from '@react-three/drei'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import {
  api, type ClusterState, type Edge, type K8sObject, deploymentHealth, describePod, HEALTH_COLOR,
  keyOf, NODE_COLORS, podStatus, STATUS_COLOR,
} from './k8s'
import { FacadeSign, Landmark, type LandmarkInfo, landmarkFor } from './landmarks'
import { BUILDING, buildRoads, carTrip, type CityLayout, checkRoads, layoutCity, offsetPath, Path, ROAD_W } from './layout'
import { Scenery } from './scenery'
import { nameOf, roleOf } from './teach'
import { textTexture, type TextLine } from './textures'
import type { Theme } from './theme'

export interface HoverInfo { title: string; lines: string[]; x: number; y: number }
type OnHover = (h: HoverInfo | null) => void
/** Per-service state the City needs for labelling: down, or impacted via a chain of dependencies. */
export type ServiceState = Record<string, { down: boolean; chain: string[] | null }>

const UNIT = 1
const UNIT_GAP = 1.45
const UNIT_COLS = 6
const UNIT_Z = 4.4
const CAR_SPEED = 7 // world units per second
const CAR_GROW = 2.2 // distance over which a Car grows as it leaves a Building and shrinks as it enters one
const CAR_POOL = 14  // most Cars drawn on one Road at once
/** A Building's size follows its desired replica count: small when asked for 0, half again as big at 10. */
export const sizeFor = (replicas: number) => 0.75 + 0.075 * Math.max(0, Math.min(10, replicas))
const AMBER = '#f59e0b'
const RED = '#ef4444'

const at = (e: ThreeEvent<PointerEvent>) => ({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY })

// ---------- shared shapes ----------

function roundedRect(w: number, d: number, r: number) {
  const s = new THREE.Shape(), x = -w / 2, y = -d / 2
  s.moveTo(x + r, y); s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r)
  s.lineTo(x + w, y + d - r); s.quadraticCurveTo(x + w, y + d, x + w - r, y + d)
  s.lineTo(x + r, y + d); s.quadraticCurveTo(x, y + d, x, y + d - r)
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y)
  return s
}

/** A flat rounded rectangle lying on the ground. */
function Pad({ w, d, r, position, color, opacity = 1 }: {
  w: number; d: number; r: number; position: [number, number, number]; color: string; opacity?: number
}) {
  const shape = useMemo(() => roundedRect(w, d, r), [w, d, r])
  return (
    <mesh rotation-x={-Math.PI / 2} position={position} receiveShadow>
      <shapeGeometry args={[shape]} />
      <meshStandardMaterial color={color} transparent={opacity < 1} opacity={opacity} />
    </mesh>
  )
}

/** A flat strip following a polyline. */
function ribbon(pts: THREE.Vector3[], width: number, y: number) {
  const left = offsetPath(pts, -width / 2), right = offsetPath(pts, width / 2)
  const pos: number[] = [], idx: number[] = []
  pts.forEach((_, i) => {
    pos.push(left[i].x, y, left[i].z, right[i].x, y, right[i].z)
    if (i) { const a = 2 * (i - 1); idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2) }
  })
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

// ---------- floating name tags (canvas sprites at a constant on-screen size) ----------

function Tag({ lines, border, position, size = 0.043, theme }: {
  lines: TextLine[]; border: string; position: [number, number, number]; size?: number; theme: Theme
}) {
  const key = JSON.stringify(lines) + border + theme.mode
  const { texture, aspect } = useMemo(() => textTexture(lines, { bg: theme.labelBg, border }), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => texture.dispose(), [texture])
  return (
    <sprite position={position} scale={[size * aspect, size, 1]} center={[0.5, 0]} renderOrder={10}>
      <spriteMaterial map={texture} depthTest={false} transparent sizeAttenuation={false} />
    </sprite>
  )
}

/** Text painted flat on the ground, readable from the default camera side. */
function GroundText({ text, height, position, color }: { text: string; height: number; position: [number, number, number]; color: string }) {
  const { texture, aspect } = useMemo(() => textTexture([{ text, px: 72, color, weight: 800 }], { bg: 'rgba(0,0,0,0)', pad: 8 }), [text, color])
  useEffect(() => () => texture.dispose(), [texture])
  return (
    <mesh rotation-x={-Math.PI / 2} position={[position[0] + (height * aspect) / 2, position[1], position[2]]}>
      <planeGeometry args={[height * aspect, height]} />
      <meshBasicMaterial map={texture} transparent depthWrite={false} />
    </mesh>
  )
}

// ---------- ground and Districts ----------

function Ground({ layout, theme }: { layout: CityLayout; theme: Theme }) {
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[900, 900]} />
        <meshStandardMaterial color={theme.ground} />
      </mesh>
      {layout.districts.map((d) => (
        <group key={d.name}>
          <Pad w={d.x1 - d.x0} d={d.z1 - d.z0} r={5} position={[(d.x0 + d.x1) / 2, 0, (d.z0 + d.z1) / 2]} color={theme.district} />
          <GroundText text={`${d.name.toUpperCase()} DISTRICT`} height={1.5} position={[d.x0 + 2.5, 0.03, d.z1 - 1.4]} color={theme.groundText} />
        </group>
      ))}
    </group>
  )
}

// ---------- Roads: one per call between two services ----------

function Road({ pts, edge, emphasis, theme }: { pts: THREE.Vector3[]; edge: Edge; emphasis: 'normal' | 'dim' | 'strong'; theme: Theme }) {
  const asphalt = useMemo(() => ribbon(pts, ROAD_W, 0.012), [pts])
  // Failing roads sit a hair higher so red wins where two roads share a stretch.
  const line = useMemo(() => ribbon(pts, emphasis === 'strong' ? 0.34 : 0.2, edge.healthy ? 0.02 : 0.026), [pts, emphasis, edge.healthy])
  useEffect(() => () => { asphalt.dispose(); line.dispose() }, [asphalt, line])
  const color = !edge.healthy ? RED : edge.rps === 0 ? '#94a3b8' : theme.roadGlow
  return (
    <group>
      <mesh geometry={asphalt} receiveShadow><meshStandardMaterial color={theme.street} side={THREE.DoubleSide} /></mesh>
      <mesh geometry={line}><meshBasicMaterial color={color} toneMapped={false} transparent opacity={emphasis === 'dim' ? 0.25 : 1} side={THREE.DoubleSide} /></mesh>
    </group>
  )
}

// ---------- Buildings, Units, Plots ----------

function slot(i: number, total: number): THREE.Vector3 {
  const row = Math.floor(i / UNIT_COLS)
  const inRow = Math.min(UNIT_COLS, total - row * UNIT_COLS)
  return new THREE.Vector3(((i % UNIT_COLS) - (inRow - 1) / 2) * UNIT_GAP, 0, UNIT_Z + row * UNIT_GAP)
}

function Unit({ pod, target, powerGrid, nodeColor, onHover }: {
  pod: K8sObject; target: THREE.Vector3; powerGrid: boolean; nodeColor?: string; onHover: OnHover
}) {
  const status = podStatus(pod)
  const ref = useRef<THREE.Group>(null)
  const mat = useRef<THREE.MeshStandardMaterial>(null)
  const color = powerGrid ? nodeColor ?? '#64748b' : STATUS_COLOR[status]
  useFrame(({ clock }, dt) => {
    if (ref.current) ref.current.position.lerp(target, Math.min(1, dt * 6)) // slide (and drop in), don't jump
    if (mat.current) {
      const pulse = status === 'CrashLoopBackOff' || status === 'ContainerCreating'
      mat.current.emissiveIntensity = pulse ? 0.15 + 0.75 * Math.abs(Math.sin(clock.elapsedTime * 4)) : 0.45
    }
  })
  const faint = status === 'Terminating' || status === 'Pending'
  return (
    <group ref={ref} position={[target.x, 3, target.z]}
      onPointerOver={(e) => { e.stopPropagation(); onHover({ title: `Unit ${pod.metadata.name}`, lines: [describePod(pod), `Pod · ${status}`, `Runs on: ${pod.spec.nodeName ?? 'no Node yet'}`], ...at(e) }) }}
      onPointerOut={() => onHover(null)}>
      <mesh position={[0, 0.5, 0]} castShadow>
        <boxGeometry args={[UNIT, 0.84, UNIT]} />
        <meshStandardMaterial ref={mat} color={color} emissive={color} transparent opacity={faint ? 0.4 : 1} />
      </mesh>
      <mesh position={[0, 0.98, 0]}>
        <boxGeometry args={[UNIT + 0.1, 0.12, UNIT + 0.1]} />
        <meshStandardMaterial color="#f8fafc" transparent opacity={faint ? 0.4 : 1} />
      </mesh>
    </group>
  )
}

/** The marked space for one desired replica. Empty ones (no Pod yet) are outlined brightly. */
function Plot({ position, empty, theme }: { position: THREE.Vector3; empty: boolean; theme: Theme }) {
  return (
    <mesh position={[position.x, 0.04, position.z]}>
      <boxGeometry args={[UNIT + 0.28, 0.06, UNIT + 0.28]} />
      <meshStandardMaterial color={theme.plot} transparent opacity={empty ? 0.25 : 1} />
      {empty && <Edges color={theme.marking} />}
    </mesh>
  )
}

function tagFor(dep: K8sObject, info: LandmarkInfo, state: ServiceState[string] | undefined, theme: Theme): { lines: TextLine[]; border: string } {
  const ready = dep.status.readyReplicas ?? 0, want = dep.spec.replicas
  const health = deploymentHealth(dep)
  const title: TextLine = { text: `${info.emoji} ${dep.metadata.name}`, px: 56, color: theme.labelFg }
  const night = theme.mode === 'night'
  const amber = night ? AMBER : '#b45309', red = night ? '#f87171' : '#dc2626' // text needs more contrast on the light tag
  if (state?.down) return { lines: [title, { text: `DOWN · ${ready}/${want} ready`, px: 40, color: red }], border: RED }
  if (state?.chain) return { lines: [title, { text: `⚠ IMPACTED · needs ${nameOf(state.chain[state.chain.length - 1])}`, px: 40, color: amber }], border: AMBER }
  const color = health === 'healthy' ? (night ? '#4ade80' : '#15803d') : amber
  return { lines: [title, { text: `${info.title} · ${ready}/${want} ready`, px: 40, color }], border: HEALTH_COLOR[health] }
}

function Building({ dep, info, pods, pos, selected, onSelect, powerGrid, nodeColors, theme, onHover, state }: {
  dep: K8sObject; info: LandmarkInfo; pods: K8sObject[]; pos: THREE.Vector3; selected: boolean; onSelect: () => void
  powerGrid: boolean; nodeColors: Record<string, string>; theme: Theme; onHover: OnHover; state?: ServiceState[string]
}) {
  const health = deploymentHealth(dep)
  const desired: number = dep.spec.replicas
  const sorted = [...pods].sort((a, b) => (a.metadata.creationTimestamp ?? '').localeCompare(b.metadata.creationTimestamp ?? ''))
  const total = Math.max(desired, sorted.length)
  const glow = state?.chain && health === 'healthy' ? AMBER : HEALTH_COLOR[health]
  const role = roleOf(dep.metadata.name)
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHover({ title: `${info.emoji} ${info.title}: ${dep.metadata.name}`, lines: [role.does, `If it stops: ${role.ifDown}`, 'Click to inspect'], ...at(e) })
  }
  const tag = tagFor(dep, info, state, theme)
  const size = sizeFor(desired)
  const body = useRef<THREE.Group>(null)
  useFrame((_, dt) => { body.current?.scale.lerp(new THREE.Vector3(size, size, size), Math.min(1, dt * 4)) })
  return (
    <group position={pos}>
      {selected && <Pad w={17} d={17} r={3.5} position={[0, 0.008, -0.6]} color={info.accent} opacity={0.4} />}
      <group ref={body} position={[0, 0, -2]} scale={size}>
        <Landmark info={info} glow={glow} theme={theme} />
        {/* One invisible hit-box for hover/click instead of handlers on every part */}
        <mesh position={[0, info.height / 2, -0.5]} visible={false}
          onClick={(e) => { e.stopPropagation(); onSelect() }}
          onPointerOver={hover} onPointerMove={hover} onPointerOut={() => onHover(null)}>
          <boxGeometry args={[9, info.height, 6]} />
        </mesh>
      </group>
      {Array.from({ length: desired }, (_, i) => <Plot key={i} position={slot(i, total)} empty={i >= sorted.length} theme={theme} />)}
      {sorted.map((p, i) => (
        <Unit key={p.metadata.uid} pod={p} target={slot(i, total)} powerGrid={powerGrid} nodeColor={nodeColors[p.spec.nodeName]} onHover={onHover} />
      ))}
      {/* outside the scaled group: a sprite would inherit its scale */}
      <Tag lines={tag.lines} border={selected ? info.accent : tag.border} position={[0, info.height * size + 0.8, -2]} theme={theme} />
    </group>
  )
}

// ---------- Power Stations (Nodes) ----------

function PowerStation({ node, pos, used, color, theme, onHover }: {
  node: K8sObject; pos: THREE.Vector3; used: number; color: string; theme: Theme; onHover: OnHover
}) {
  const ready = node.status.conditions[0].status === 'True'
  const capacity = Number(node.status.capacity.pods)
  const name = node.metadata.name
  const night = theme.mode === 'night'
  const beacon = useRef<THREE.Mesh>(null)
  const smoke = useRef<THREE.Group>(null)
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    if (beacon.current) beacon.current.visible = ready || Math.sin(t * 8) > 0
    smoke.current?.children.forEach((c, i) => {
      const k = (t * 0.3 + i / 3) % 1
      c.position.y = 5 + k * 3.5
      c.scale.setScalar(0.5 + k * 1.1)
      ;((c as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = ready ? 0.45 * (1 - k) : 0
    })
  })
  const wall = night ? '#7483a0' : '#ece8df'
  const concrete = night ? '#5d6a85' : '#d3cec3'
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHover({
      title: `⚡ Power Station ${name}`,
      lines: ['A Node: a machine that runs Pods.', ready ? `Running ${used} of ${capacity} Pod slots.` : 'POWER CUT: its Pods were evicted.',
        ready ? 'Click to cut power (Node Outage).' : 'Click to restore power.'],
      ...at(e),
    })
  }
  return (
    <group position={pos} scale={0.85}>
      <Pad w={13} d={10.5} r={2.5} position={[0, 0.006, -0.3]} color={theme.district} />
      <mesh position={[-1.2, 1.5, 1.6]} castShadow receiveShadow><boxGeometry args={[6.4, 3, 3.2]} /><meshStandardMaterial color={wall} /></mesh>
      <mesh position={[-1.2, 3.1, 1.6]}><boxGeometry args={[6.7, 0.22, 3.5]} /><meshStandardMaterial color={color} /></mesh>
      {/* Capacity meter: one light per Pod slot, lit when used */}
      {Array.from({ length: capacity }, (_, i) => (
        <mesh key={i} position={[-3.6 + i * 1.2, 0.95, 3.23]}>
          <boxGeometry args={[0.85, 1.1, 0.06]} />
          <meshBasicMaterial color={ready && i < used ? color : night ? '#1e293b' : '#94a3b8'} toneMapped={false} />
        </mesh>
      ))}
      {[[2.9, -1.9], [-0.4, -2.3]].map(([x, z]) => (
        <group key={x} position={[x, 0, z]}>
          <mesh position={[0, 2.3, 0]} castShadow><cylinderGeometry args={[0.95, 1.5, 4.6, 24]} /><meshStandardMaterial color={concrete} /></mesh>
          <mesh position={[0, 4.62, 0]}><cylinderGeometry args={[1.02, 0.95, 0.14, 24]} /><meshStandardMaterial color={color} /></mesh>
        </group>
      ))}
      <group ref={smoke}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[2.9, 5, -1.9]}><sphereGeometry args={[0.8, 10, 8]} /><meshStandardMaterial color="#e2e8f0" transparent opacity={0.4} depthWrite={false} /></mesh>
        ))}
      </group>
      <mesh position={[-4.6, 3, -2.4]} castShadow><cylinderGeometry args={[0.24, 0.32, 6, 12]} /><meshStandardMaterial color={concrete} /></mesh>
      {[4.6, 5.4].map((y) => <mesh key={y} position={[-4.6, y, -2.4]}><cylinderGeometry args={[0.27, 0.28, 0.32, 12]} /><meshStandardMaterial color="#dc2626" /></mesh>)}
      <mesh ref={beacon} position={[-4.6, 6.2, -2.4]}><sphereGeometry args={[0.22, 10, 8]} /><meshBasicMaterial color={ready ? color : RED} toneMapped={false} /></mesh>
      {[3.6, 4.8].map((x) => <mesh key={x} position={[x, 0.55, 2]} castShadow><boxGeometry args={[0.9, 1.1, 0.9]} /><meshStandardMaterial color={night ? '#55627d' : '#a8b0bc'} /></mesh>)}
      <FacadeSign text="POWER STATION" width={3.8} pos={[-1.2, 2.25, 3.23]} bg={ready ? color : '#7f1d1d'} theme={theme} />
      <mesh position={[0, 2.6, 0]} visible={false} onPointerOver={hover} onPointerMove={hover} onPointerOut={() => onHover(null)}
        onClick={(e) => { e.stopPropagation(); onHover(null); api.outage(name, ready) }}>
        <boxGeometry args={[12, 5.2, 9.5]} />
      </mesh>
      <Tag theme={theme} position={[-0.5, 7, 0]} border={ready ? color : RED} size={0.036}
        lines={[{ text: `⚡ ${name}`, px: 56, color: theme.labelFg },
          ready ? { text: `Node · ${used}/${capacity} slots used`, px: 40, color: night ? '#cbd5e1' : '#334155' }
            : { text: 'POWER CUT', px: 40, color: RED }]} />
    </group>
  )
}

// ---------- Cars ----------

interface CarAgent { s: number; fail: boolean; slot: number }

/**
 * Cars are independent agents: each spawns inside the caller, grows as it drives out, and either
 * shrinks into the callee (success) or makes a U-turn at its door and drives home (failure).
 * A failure only affects Cars spawned after it, so nothing on the Road jumps when health changes.
 */
function Traffic({ edge, road, theme, accent, onHover }: {
  edge: Edge; road: THREE.Vector3[]; theme: Theme; accent: string; onHover: OnHover
}) {
  const trips = useMemo(() => ({ ok: new Path(carTrip(road, false)), fail: new Path(carTrip(road, true)) }), [road])
  const cars = useRef<CarAgent[]>([])
  const timer = useRef(0)
  const live = useRef(edge)
  live.current = edge
  const groups = useRef<(THREE.Group | null)[]>([])
  const paints = useRef<(THREE.MeshStandardMaterial | null)[]>([])
  const hazards = useRef<(THREE.Group | null)[]>([])
  const tmp = useMemo(() => new THREE.Vector3(), [])
  const okColor = useMemo(() => new THREE.Color(accent), [accent])
  const failColor = useMemo(() => new THREE.Color(RED), [])
  useFrame(({ clock }, rawDt) => {
    const dt = Math.min(rawDt, 0.1) // a hidden tab must not dump a burst of Cars
    const e = live.current
    const n = Math.ceil(e.rps)
    if (n > 0 && (timer.current -= dt) <= 0) {
      const used = new Set(cars.current.map((c) => c.slot))
      const slot = [...Array(CAR_POOL).keys()].find((i) => !used.has(i))
      if (slot !== undefined) cars.current.push({ s: 0, fail: !e.healthy, slot })
      timer.current = trips.ok.length / CAR_SPEED / n // about n Cars on the Road at once
    }
    cars.current = cars.current.filter((c) => (c.s += CAR_SPEED * dt) < (c.fail ? trips.fail : trips.ok).length)
    const blink = Math.sin(clock.elapsedTime * 12) > 0
    groups.current.forEach((g, i) => {
      if (!g) return
      const car = cars.current.find((c) => c.slot === i)
      g.visible = !!car
      if (!car) return
      const trip = car.fail ? trips.fail : trips.ok
      g.rotation.y = trip.at(car.s, tmp)
      g.position.copy(tmp)
      g.scale.setScalar(1.15 * Math.max(0.01, Math.min(1, car.s / CAR_GROW, (trip.length - car.s) / CAR_GROW)))
      paints.current[i]?.color.copy(car.fail ? failColor : okColor)
      if (hazards.current[i]) hazards.current[i]!.visible = car.fail && blink
    })
  })
  const [src, dst] = [nameOf(edge.from), nameOf(edge.to)]
  const night = theme.mode === 'night'
  return (
    <group>
      {Array.from({ length: CAR_POOL }, (_, i) => (
        <group key={i} visible={false} ref={(g) => { groups.current[i] = g }}
          onPointerOver={(e) => {
            e.stopPropagation()
            const fail = cars.current.find((c) => c.slot === i)?.fail
            onHover({ title: `🚗 Request: ${src} → ${dst}`, lines: [fail ? `Failed: ${dst} has no working Units, so the car turns back.` : 'On its way; it will be served.', `${live.current.rps} requests/second on this road.`], ...at(e) })
          }}
          onPointerOut={() => onHover(null)}>
          <mesh position={[0, 0.3, 0]} castShadow><boxGeometry args={[1.1, 0.35, 0.6]} /><meshStandardMaterial ref={(m) => { paints.current[i] = m }} color={accent} /></mesh>
          <mesh position={[-0.1, 0.6, 0]}><boxGeometry args={[0.6, 0.3, 0.52]} /><meshStandardMaterial color={night ? '#0f172a' : '#e2e8f0'} /></mesh>
          {night && [-0.18, 0.18].map((z) => (
            <mesh key={z} position={[0.56, 0.32, z]}><boxGeometry args={[0.04, 0.1, 0.12]} /><meshBasicMaterial color="#fef9c3" toneMapped={false} /></mesh>
          ))}
          <group ref={(g) => { hazards.current[i] = g }} visible={false}>
            {[-0.22, 0.22].map((z) => (
              <mesh key={z} position={[-0.56, 0.35, z]}><boxGeometry args={[0.06, 0.12, 0.14]} /><meshBasicMaterial color="#fb923c" toneMapped={false} /></mesh>
            ))}
          </group>
        </group>
      ))}
    </group>
  )
}

/** Street lamps along every Road (decoration), as two instanced meshes. */
function Lamps({ points, theme }: { points: THREE.Vector3[]; theme: Theme }) {
  const poles = useRef<THREE.InstancedMesh>(null), heads = useRef<THREE.InstancedMesh>(null)
  useEffect(() => {
    const m = new THREE.Matrix4()
    points.forEach((p, i) => {
      poles.current?.setMatrixAt(i, m.makeTranslation(p.x, 1.3, p.z))
      heads.current?.setMatrixAt(i, m.makeTranslation(p.x, 2.65, p.z))
    })
    if (poles.current) poles.current.instanceMatrix.needsUpdate = true
    if (heads.current) heads.current.instanceMatrix.needsUpdate = true
  }, [points])
  const night = theme.mode === 'night'
  return (
    <group>
      <instancedMesh ref={poles} args={[undefined, undefined, points.length]} castShadow>
        <cylinderGeometry args={[0.06, 0.08, 2.6, 6]} /><meshStandardMaterial color={night ? '#64748b' : '#475569'} />
      </instancedMesh>
      <instancedMesh ref={heads} args={[undefined, undefined, points.length]}>
        <sphereGeometry args={[0.2, 10, 8]} />
        <meshBasicMaterial color={night ? '#fde68a' : '#e2e8f0'} toneMapped={false} />
      </instancedMesh>
    </group>
  )
}

// ---------- camera: overview and fly-to ----------

interface Controls extends THREE.EventDispatcher<{ start: object }> { target: THREE.Vector3; update(): void }

function CameraRig({ focus, layout, homeTick }: { focus: THREE.Vector3 | null; layout: CityLayout; homeTick: number }) {
  const camera = useThree((s) => s.camera) as THREE.PerspectiveCamera
  const aspect = useThree((s) => s.size.width / s.size.height)
  const controls = useThree((s) => s.controls) as unknown as Controls | null
  const flying = useRef(false)
  const goal = useRef({ target: new THREE.Vector3(), cam: new THREE.Vector3() })
  const fly = (target: THREE.Vector3, offset: THREE.Vector3) => {
    goal.current.target.copy(target)
    goal.current.cam.copy(target).add(offset)
    flying.current = true
  }
  const { x0, x1, z0, z1 } = layout.core
  // Overview: back off far enough that the whole core fits the viewport width.
  useEffect(() => {
    const span = Math.max(x1 - x0, (z1 - z0) * 1.5, 40)
    const dist = (span * 0.62) / (Math.tan((camera.fov * Math.PI) / 360) * Math.min(aspect, 2))
    fly(new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2 + 2), new THREE.Vector3(0, dist * 0.62, dist * 0.78))
  }, [x0, x1, z0, z1, homeTick]) // eslint-disable-line react-hooks/exhaustive-deps
  // Fly-to: look slightly right of the Building so it is not hidden behind the inspect panel.
  useEffect(() => { if (focus) fly(focus.clone().add(new THREE.Vector3(5, 2, 0)), new THREE.Vector3(6, 19, 24)) }, [focus])
  useEffect(() => {
    if (!controls) return
    const stop = () => { flying.current = false } // the user grabbed the camera
    controls.addEventListener('start', stop)
    return () => controls.removeEventListener('start', stop)
  }, [controls])
  useFrame((_, dt) => {
    if (!flying.current || !controls) return
    const k = Math.min(1, dt * 2.5)
    controls.target.lerp(goal.current.target, k)
    camera.position.lerp(goal.current.cam, k)
    controls.update()
    if (camera.position.distanceTo(goal.current.cam) < 0.05) flying.current = false
  })
  return null
}

// ---------- the City ----------

export function City({ cluster, selected, onSelect, powerGrid, theme, onHover, states, homeTick }: {
  cluster: ClusterState; selected: string | null; onSelect: (key: string | null) => void
  powerGrid: boolean; theme: Theme; onHover: OnHover; states: ServiceState; homeTick: number
}) {
  const all = Object.values(cluster.objects)
  const deployments = all.filter((o) => o.kind === 'Deployment')
  const pods = all.filter((o) => o.kind === 'Pod')
  const nodes = all.filter((o) => o.kind === 'Node').sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const nodeColors = Object.fromEntries(nodes.map((n, i) => [n.metadata.name, NODE_COLORS[i % NODE_COLORS.length]]))
  // Keyed on names and from→to pairs only: failures change rps/health, and the city must not rearrange.
  const layoutKey = [deployments.map(keyOf).sort(), nodes.map((n) => n.metadata.name), cluster.edges.map((e) => `${e.from}>${e.to}`).sort()].join('|')
  const { layout, roads, obstacles, lamps } = useMemo(() => {
    const calls = cluster.edges.map((e) => ({ from: e.from, to: e.to }))
    const layout = layoutCity(deployments.map((d) => ({ namespace: d.metadata.namespace!, name: d.metadata.name })),
      nodes.map((n) => n.metadata.name), calls)
    const roads = buildRoads(layout, calls)
    if (import.meta.env.DEV) checkRoads(layout, roads)
    const lots = [...Object.values(layout.lots), ...Object.values(layout.stations)]
    const clear = (p: THREE.Vector3) => lots.every((l) => Math.abs(p.x - l.center.x) > BUILDING.halfW + 1 ||
      p.z < l.center.z + BUILDING.back - 1 || p.z > l.center.z + BUILDING.front + 1)
    // Lamps every ~9 units on the left kerb of each Road, wherever that is clear of Buildings.
    const lamps = Object.values(roads).flatMap((r) => {
      const kerb = new Path(offsetPath(r, -(ROAD_W / 2 + 0.6)))
      return Array.from({ length: Math.floor(kerb.length / 9) }, (_, i) => {
        const v = new THREE.Vector3()
        kerb.at(4.5 + i * 9, v)
        return v
      })
    }).filter(clear)
    // What Scenery must keep clear of: Buildings at full size, Power Stations, Roads.
    const obstacles = [
      ...Object.values(layout.lots).map((l) => ({ x: l.center.x, z: l.center.z - 0.4, rad: 9.5 })),
      ...Object.values(layout.stations).map((l) => ({ x: l.center.x, z: l.center.z, rad: 8 })),
      ...Object.values(roads).flatMap((r) => r.filter((_, i) => i % 2 === 0).map((p) => ({ x: p.x, z: p.z, rad: 2.4 }))),
    ]
    return { layout, roads, obstacles, lamps }
  }, [layoutKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const edges = cluster.edges.filter((e) => roads[`${e.from}>${e.to}`])
  const focus = selected && layout.lots[selected] ? layout.lots[selected].center : null
  const podsOn = (node: string) => pods.filter((p) => p.spec.nodeName === node && !p.metadata.deletionTimestamp).length
  const ready = deployments.length > 0

  return (
    <Canvas shadows camera={{ position: [0, 60, 80], fov: 45 }} onPointerMissed={() => onSelect(null)}>
      <color attach="background" args={[theme.sky]} />
      <fog attach="fog" args={[theme.sky, ...theme.fog]} />
      <ambientLight intensity={theme.ambient} />
      <hemisphereLight args={[theme.sky, theme.ground, theme.ambient * 0.5]} />
      <directionalLight position={[30, 45, 25]} intensity={theme.sun} color={theme.sunColor} castShadow
        shadow-mapSize={[2048, 2048]} shadow-camera-left={-80} shadow-camera-right={80} shadow-camera-top={80} shadow-camera-bottom={-80} shadow-camera-far={220} />
      <Ground layout={layout} theme={theme} />
      {ready && <Scenery core={layout.core} districts={layout.districts} obstacles={obstacles} theme={theme} />}
      {ready && <Lamps points={lamps} theme={theme} />}
      {edges.map((e) => (
        <Road key={`${e.from}>${e.to}`} pts={roads[`${e.from}>${e.to}`]} edge={e} theme={theme}
          emphasis={!selected ? 'normal' : e.from === selected || e.to === selected ? 'strong' : 'dim'} />
      ))}
      {nodes.map((n) => layout.stations[n.metadata.name] && (
        <PowerStation key={n.metadata.uid} node={n} pos={layout.stations[n.metadata.name].center} used={podsOn(n.metadata.name)}
          color={nodeColors[n.metadata.name]} theme={theme} onHover={onHover} />
      ))}
      {deployments.map((dep) => {
        const key = keyOf(dep)
        const lot = layout.lots[key]
        if (!lot) return null
        return (
          <Building key={dep.metadata.uid} dep={dep} info={landmarkFor(dep.metadata.name)} pos={lot.center}
            selected={selected === key} onSelect={() => onSelect(key)} powerGrid={powerGrid} nodeColors={nodeColors}
            theme={theme} onHover={onHover} state={states[key]}
            pods={pods.filter((p) => p.metadata.namespace === dep.metadata.namespace && p.metadata.labels?.app === dep.metadata.name)} />
        )
      })}
      {edges.map((e) => (
        <Traffic key={`${e.from}>${e.to}`} edge={e} road={roads[`${e.from}>${e.to}`]} theme={theme} onHover={onHover}
          accent={landmarkFor(nameOf(e.from)).accent} />
      ))}
      <OrbitControls makeDefault maxPolarAngle={Math.PI / 2.15} minDistance={10} maxDistance={170} />
      <CameraRig focus={focus} layout={layout} homeTick={homeTick} />
    </Canvas>
  )
}
