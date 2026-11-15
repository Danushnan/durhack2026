import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { Edges, OrbitControls, OrthographicCamera, PerspectiveCamera } from '@react-three/drei'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import {
  type ClusterState, type Edge, type K8sObject, deploymentHealth, describePod, HEALTH_COLOR, isWorkload,
  keyOf, NODE_COLORS, nodeReady, podsOf, podStatus, rolloutOf, STATUS_COLOR, versionColor,
} from './k8s'
import { FacadeSign, Landmark, type LandmarkInfo, landmarkFor } from './landmarks'
import { BUILDING, carTrip, type Call, type CityLayout, KERB, layoutCity, offsetPath, Path, ROAD_W } from './layout'
import { Scenery } from './scenery'
import { COMPONENTS, componentOf, nameOf, roleOf } from './teach'
import { textTexture, type TextLine } from './textures'
import type { Theme } from './theme'
import { type Affected, describeFlow, type Flow, rates, type serviceFlow, SIGNAL, signalOf } from './health'
import { admit, bendLimit, type CarAgent, CARS_PER_REQUEST, DRIVE, exitClear, newCar, stepCars } from './traffic'
import { label, latencyText, type LiveServiceView } from './liveMetrics'
import { miniShopLayoutCalls } from './miniShopRoads'
import { roadKey, roadVisible } from './roadDiscovery'
import { buildStreetNetwork, crossesDistricts, HIGHWAY_WIDTH, ROUNDABOUT_RADIUS, type Roundabout, type StreetRoute } from './streetNetwork'

export interface HoverInfo { title: string; lines: string[]; x: number; y: number }
type OnHover = (h: HoverInfo | null) => void
/** Per-service state the City needs for labelling: down, or impacted via a chain of dependencies. */
export type ServiceState = Record<string, {
  down: boolean; chain: string[] | null
  flow: ReturnType<typeof serviceFlow>   // how its requests are going (separate from its Pods)
  affected: Affected | null              // why it needs attention, if it does
  live?: LiveServiceView
}>
/** Isometric (fixed angle, orthographic) or free 3D (perspective, orbit). */
export type ViewMode = 'iso' | '3d'
/** A Road's traffic: the call, with measured rates and latency. */
export type RoadFlow = Edge & Flow & { measured?: boolean } // measured: TigerData rows replaced the live rates

const UNIT = 1
const UNIT_GAP = 1.45
const UNIT_COLS = 6
const UNIT_Z = 4.4
const CAR_GROW = 2.2 // distance over which a Car grows as it leaves a Building and shrinks as it enters one
const CAR_POOL = 40  // most Cars drawn on one Road at once (rush hour fills a Road bumper to bumper)
const GRIP = 9       // how hard Cars may corner: bends below this radius slow them down
// Isometric view: an orthographic camera looking down the (1, 1, 1) diagonal from this far away.
const ISO = new THREE.Vector3(1, 1, 1).normalize()
const CAM_DIST = 300
const ISO_RIGHT = new THREE.Vector3(1, 0, -1).normalize(), ISO_UP = new THREE.Vector3(-1, 2, -1).normalize()
const TAG_SCALE = 1 / (2 * Math.tan(Math.PI / 8)) // keeps tags the size they had under the old 45° perspective camera
/** A pan that ends over a Building must not also select it. */
const dragged = (e: ThreeEvent<MouseEvent>) => e.delta > 4
const ORANGE = SIGNAL.errors.color // an error response: the service answered, but could not do the job
/** A Building's size follows its desired replica count: small when asked for 0, half again as big at 10. */
export const sizeFor = (replicas: number) => 0.75 + 0.075 * Math.max(0, Math.min(10, replicas))
const AMBER = '#f59e0b'
const RED = SIGNAL.refused.color

const at = (e: ThreeEvent<PointerEvent>) => ({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY })
const CUSTOMER = '#facc15' // customers arriving through a City Gate drive yellow taxis

// When a Car delivers a request, the Service hands it to the next ready Pod (round-robin); that Unit
// flashes. Shared mutable state, read in animation frames, so deliveries never cause React re-renders.
const servedAt = new Map<string, number>()
const turn = new Map<string, number>()
function deliver(service: string, endpoints: string[], now: number) {
  if (!endpoints.length) return
  const i = (turn.get(service) ?? 0) % endpoints.length
  turn.set(service, i + 1)
  servedAt.set(endpoints[i], now)
}

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
  const ref = useRef<THREE.Sprite>(null)
  // An orthographic camera ignores sizeAttenuation, so scale by the zoom to keep a constant on-screen size.
  useFrame(({ camera, size: view }) => {
    const k = (camera as THREE.OrthographicCamera).isOrthographicCamera ? (TAG_SCALE * view.height) / camera.zoom : 1
    ref.current?.scale.set(size * aspect * k, size * k, 1)
  })
  return (
    <sprite ref={ref} position={position} scale={[size * aspect, size, 1]} center={[0.5, 0]} renderOrder={10}>
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
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.08, 0]} receiveShadow>
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

// ---------- Shared streets and roundabouts ----------

/** Painted marks along a Road (centre dashes, lane arrows) as one instanced mesh. */
function Marks({ pts, every, offset, start, geometry, color, opacity = 1 }: {
  pts: THREE.Vector3[]; every: number; offset: number; start: number; geometry: THREE.BufferGeometry; color: string; opacity?: number
}) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const spots = useMemo(() => {
    const path = new Path(offset ? offsetPath(pts, offset) : pts), out: { p: THREE.Vector3; h: number }[] = []
    for (let s = start; s < path.length - 3; s += every) { const p = new THREE.Vector3(); out.push({ p, h: path.at(s, p) }) }
    return out
  }, [pts, every, offset, start])
  useLayoutEffect(() => {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), one = new THREE.Vector3(1, 1, 1)
    spots.forEach(({ p, h }, i) => ref.current?.setMatrixAt(i, m.compose(p, q.setFromAxisAngle(up, h), one)))
    if (ref.current) ref.current.instanceMatrix.needsUpdate = true
  }, [spots, geometry])
  return (
    <instancedMesh ref={ref} args={[geometry, undefined, spots.length]}>
      <meshBasicMaterial color={color} transparent={opacity < 1} opacity={opacity} toneMapped={false} />
    </instancedMesh>
  )
}
const dash = new THREE.BoxGeometry(1.3, 0.02, 0.13).translate(0, 0.024, 0)
const arrow = (() => {
  const s = new THREE.Shape()
  s.moveTo(0.55, 0); s.lineTo(-0.35, 0.38); s.lineTo(-0.15, 0); s.lineTo(-0.35, -0.38); s.closePath()
  return new THREE.ShapeGeometry(s).rotateX(-Math.PI / 2).translate(0, 0.023, 0)
})()

type StreetUse = { call: Call; edge?: RoadFlow; preview?: boolean }

const callLabel = ({ from, to }: Call) => `${from.startsWith('ingress:') ? 'customers' : nameOf(from)} → ${nameOf(to)}`

function Road({ pts, uses, highway, selected, theme, onHover }: {
  pts: THREE.Vector3[]; uses: StreetUse[]; highway: boolean; selected: string | null; theme: Theme; onHover: OnHover
}) {
  const width = highway ? HIGHWAY_WIDTH : ROAD_W
  const geo = useMemo(() => ({
    kerb: ribbon(pts, width + 2 * KERB, 0.006),
    asphalt: ribbon(pts, width, 0.014),
    left: ribbon(offsetPath(pts, -(width / 2 - 0.14)), 0.16, 0.022),
    right: ribbon(offsetPath(pts, width / 2 - 0.14), 0.16, 0.022),
  }), [pts, width])
  useEffect(() => () => Object.values(geo).forEach((g) => g.dispose()), [geo])
  const signal = uses.reduce((worst, { edge }) => {
    const current = SIGNAL[edge ? signalOf(edge) : 'idle']
    return current.rank > worst.rank ? current : worst
  }, SIGNAL.idle)
  const dim = !selected || uses.some(({ call }) => call.from === selected || call.to === selected) ? 1 : 0.3
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const title = highway ? 'District highway' : uses.length === 1 ? callLabel(uses[0].call) : 'Shared road'
    onHover({ title: `🛣️ ${title}`, lines: uses.map(({ call, edge, preview }) => edge
      ? `${callLabel(call)} · ${SIGNAL[signalOf(edge)].label} · ${describeFlow(edge)}`
      : `${callLabel(call)} · ${preview ? 'map preview' : 'awaiting traffic measurements'}`), ...at(e) })
  }
  const glow = <meshBasicMaterial color={signal.color} toneMapped={false} transparent opacity={dim} side={THREE.DoubleSide} />
  return (
    <group>
      <mesh geometry={geo.kerb} receiveShadow><meshStandardMaterial color={theme.kerb} side={THREE.DoubleSide} /></mesh>
      <mesh geometry={geo.asphalt} receiveShadow onPointerOver={hover} onPointerMove={hover} onPointerOut={() => onHover(null)}>
        <meshStandardMaterial color={highway ? new THREE.Color(theme.street).multiplyScalar(0.78) : theme.street} roughness={0.95} side={THREE.DoubleSide} />
      </mesh>
      <mesh geometry={geo.left}>{glow}</mesh>
      <mesh geometry={geo.right}>{glow}</mesh>
      <Marks pts={pts} every={highway ? 3.8 : 2.6} offset={0} start={2} geometry={dash} color={theme.laneMark} opacity={0.9 * dim} />
    </group>
  )
}

function RoundaboutMesh({ center, theme }: { center: Roundabout['center']; theme: Theme }) {
  const outer = ROUNDABOUT_RADIUS + ROAD_W / 2
  const island = ROUNDABOUT_RADIUS - ROAD_W / 2 + 0.35
  return (
    <group position={center}>
      <mesh rotation-x={-Math.PI / 2} position-y={0.007} receiveShadow>
        <circleGeometry args={[outer + KERB, 40]} /><meshStandardMaterial color={theme.kerb} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.015} receiveShadow>
        <circleGeometry args={[outer, 40]} /><meshStandardMaterial color={theme.street} roughness={0.95} />
      </mesh>
      <mesh position-y={0.15} receiveShadow>
        <cylinderGeometry args={[island, island + 0.14, 0.27, 32]} /><meshStandardMaterial color={theme.kerb} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position-y={0.29} receiveShadow>
        <circleGeometry args={[island - 0.2, 32]} /><meshStandardMaterial color={theme.ground} />
      </mesh>
      {[0, 1, 2, 3].map((i) => {
        const angle = (i + 0.5) * Math.PI / 2, radius = ROUNDABOUT_RADIUS + ROAD_W / 4
        return <mesh key={i} geometry={arrow} position={[radius * Math.cos(angle), 0.004, radius * Math.sin(angle)]}
          rotation-y={Math.PI / 2 - angle}><meshBasicMaterial color={theme.laneMark} /></mesh>
      })}
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
  const version = pod.metadata.labels?.version
  const ring = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    if (!ring.current) return
    const k = 1 - (clock.elapsedTime - (servedAt.get(pod.metadata.uid) ?? -9)) / 0.7
    ring.current.visible = k > 0
    if (k > 0) {
      ring.current.scale.setScalar(1 + (1 - k) * 0.8)
      ;(ring.current.material as THREE.MeshBasicMaterial).opacity = k
    }
  })
  const rotation = status === 'Running' ? 'In rotation: the Service sends it requests.'
    : status === 'NotReady' ? 'Not in rotation yet: no requests until its readiness check passes.'
      : 'Not in rotation: receives no requests.'
  return (
    <group ref={ref} position={[target.x, 3, target.z]}
      onPointerOver={(e) => { e.stopPropagation(); onHover({ title: `Unit ${pod.metadata.name}${version ? ` · ${version}` : ''}`, lines: [describePod(pod), rotation, `Pod · ${status} · runs on ${pod.spec.nodeName ?? 'no Node yet'}`], ...at(e) }) }}
      onPointerOut={() => onHover(null)}>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position={[0, 0.06, 0]} visible={false}>
        <ringGeometry args={[0.72, 1.08, 28]} />
        <meshBasicMaterial color="#f59e0b" transparent toneMapped={false} />
      </mesh>
      <mesh position={[0, 0.5, 0]} castShadow>
        <boxGeometry args={[UNIT, 0.84, UNIT]} />
        <meshStandardMaterial ref={mat} color={color} emissive={color} transparent opacity={faint ? 0.4 : 1} />
      </mesh>
      <mesh position={[0, 0.98, 0]}>
        <boxGeometry args={[UNIT + 0.1, 0.12, UNIT + 0.1]} />
        {/* the cap shows the version, so a rolling update is visible as caps changing colour */}
        <meshStandardMaterial color={versionColor(version ?? 'v1')} transparent opacity={faint ? 0.4 : 1} />
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

function tagFor(dep: K8sObject, info: LandmarkInfo, state: ServiceState[string] | undefined, theme: Theme,
  rollout: ReturnType<typeof rolloutOf>): { lines: TextLine[]; border: string } {
  const ready = dep.status?.readyReplicas ?? 0, want = dep.spec.replicas
  const health = deploymentHealth(dep)
  const title: TextLine = { text: `${state?.affected ? `${state.affected.icon} ` : ''}${info.emoji} ${dep.metadata.name}`, px: 56, color: theme.labelFg }
  if (state?.live) {
    const live = state.live, m = live.metrics
    return { lines: [title,
      { text: `Infrastructure: ${label(live.infrastructure)} · ${m?.ready_replicas ?? ready}/${m?.desired_replicas ?? want} Ready`, px: 40, color: theme.labelFg },
      { text: `App: ${label(live.application)} · ${label(live.availability)}${m?.p95_latency_ms == null ? '' : ` · p95 ${latencyText(m.p95_latency_ms)}`}`, px: 40, color: live.color }],
      border: live.affected?.color ?? live.color }
  }
  const night = theme.mode === 'night'
  const amber = night ? AMBER : '#b45309', red = night ? '#f87171' : '#dc2626', green = night ? '#4ade80' : '#15803d' // text needs more contrast on the light tag
  // Line 2: the Pods (are copies running and ready?).
  const pods: TextLine = state?.down ? { text: `PODS DOWN · ${ready}/${want} ready`, px: 40, color: red }
    : rollout.stalled ? { text: `⚠ ${rollout.version} STUCK · old version serving`, px: 40, color: amber }
      : rollout.rolling && Object.keys(rollout.byVersion).length > 1
        ? { text: `ROLLING OUT ${rollout.version} · ${rollout.byVersion[rollout.version]?.ready ?? 0}/${want} ready`, px: 40, color: amber }
        : ready !== want ? { text: `Pods ${ready}/${want} ready · fixing…`, px: 40, color: amber }
          : { text: `Pods ${ready}/${want} ready · ${rollout.version}`, px: 40, color: health === 'healthy' ? green : amber }
  // Line 3: the requests (is it doing its job?).
  const flow = state?.flow
  const signal = flow ? SIGNAL[flow.signal] : null
  const requests: TextLine | null = state?.chain && !state.down ? { text: `⚠ IMPACTED · needs ${nameOf(state.chain[state.chain.length - 1])}`, px: 40, color: amber }
    : flow && signal && !state?.down ? { text: `${signal.icon} ${flow.rps > 0 ? describeFlow(flow) : 'no requests right now'}`, px: 40,
      color: flow.signal === 'refused' || flow.signal === 'errors' ? red : flow.signal === 'slow' ? amber : flow.signal === 'ok' ? green : theme.labelFg }
      : null
  return { lines: requests ? [title, pods, requests] : [title, pods], border: state?.affected?.color ?? HEALTH_COLOR[health] }
}

/** Marks an affected Building: a pulsing ring on the ground and, for serious cases, a beam of light. */
function Alarm({ color, strong }: { color: string; strong: boolean }) {
  const ring = useRef<THREE.Mesh>(null), beam = useRef<THREE.Mesh>(null)
  useFrame(({ clock }) => {
    const k = (clock.elapsedTime * 0.8) % 1
    ring.current?.scale.setScalar(0.85 + 0.35 * k)
    if (ring.current) (ring.current.material as THREE.MeshBasicMaterial).opacity = 0.75 * (1 - k)
    if (beam.current) (beam.current.material as THREE.MeshBasicMaterial).opacity = 0.16 + 0.1 * Math.sin(clock.elapsedTime * 4)
  })
  return (
    <group position={[0, 0, -0.6]}>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.05, 0]}><ringGeometry args={[7.6, 8.4, 48]} /><meshBasicMaterial color={color} transparent toneMapped={false} depthWrite={false} /></mesh>
      <mesh ref={ring} rotation-x={-Math.PI / 2} position={[0, 0.06, 0]}><ringGeometry args={[8.2, 9, 48]} /><meshBasicMaterial color={color} transparent toneMapped={false} depthWrite={false} /></mesh>
      {strong && <mesh ref={beam} position={[0, 20, -1.4]}><cylinderGeometry args={[0.5, 1.4, 40, 16, 1, true]} /><meshBasicMaterial color={color} transparent depthWrite={false} toneMapped={false} side={THREE.DoubleSide} /></mesh>}
    </group>
  )
}

/** A PersistentVolumeClaim: a storage tank beside a StatefulSet's Building. Its data outlives any Pod. */
function Tank({ claim, attached, index, accent, theme, onHover }: {
  claim: K8sObject; attached?: string; index: number; accent: string; theme: Theme; onHover: OnHover
}) {
  const night = theme.mode === 'night'
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHover({ title: `🛢️ Storage ${claim.metadata.name}`, lines: [
      'A PersistentVolumeClaim: the disk that holds this database copy\'s data.',
      attached ? `Attached to ${attached}. If that Pod is replaced, the new one with the same name gets this same disk back.`
        : 'Not attached right now, but kept: scaling back up reuses it, data and all.',
    ], ...at(e) })
  }
  return (
    <group position={[5.9, 0, -5.4 + index * 2.3]} onPointerOver={hover} onPointerMove={hover} onPointerOut={() => onHover(null)}>
      <mesh position={[0, 1, 0]} castShadow><cylinderGeometry args={[0.85, 0.85, 2, 20]} /><meshStandardMaterial color={attached ? accent : night ? '#475569' : '#94a3b8'} /></mesh>
      <mesh position={[0, 2.05, 0]}><sphereGeometry args={[0.85, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color={night ? '#cbd5e1' : '#e2e8f0'} /></mesh>
      {/* data level gauge */}
      <mesh position={[0, 1, 0.86]}><boxGeometry args={[0.18, 1.4, 0.04]} /><meshBasicMaterial color={night ? '#0f172a' : '#334155'} /></mesh>
      <mesh position={[0, 0.65, 0.88]}><boxGeometry args={[0.12, 0.7, 0.04]} /><meshBasicMaterial color={attached ? '#4ade80' : '#94a3b8'} toneMapped={false} /></mesh>
      {attached && <mesh position={[-1.2, 0.3, 0]}><boxGeometry args={[1.6, 0.18, 0.18]} /><meshStandardMaterial color="#64748b" /></mesh>}
    </group>
  )
}

function Building({ dep, info, pods, pos, selected, related, onSelect, powerGrid, nodeColors, theme, onHover, state, claims }: {
  dep: K8sObject; info: LandmarkInfo; pods: K8sObject[]; pos: THREE.Vector3; selected: boolean; onSelect: () => void
  powerGrid: boolean; nodeColors: Record<string, string>; theme: Theme; onHover: OnHover; state?: ServiceState[string]
  claims: K8sObject[]; related: boolean
}) {
  const health = deploymentHealth(dep)
  const desired: number = dep.spec.replicas
  const sorted = [...pods].sort((a, b) => (a.metadata.creationTimestamp ?? '').localeCompare(b.metadata.creationTimestamp ?? ''))
  const total = Math.max(desired, sorted.length)
  // The Building glows with its request health; its Units show its Pod health.
  const glow = state?.live?.color ?? (state?.flow ? SIGNAL[state.flow.signal].color : HEALTH_COLOR[health])
  const role = roleOf(dep.metadata.name)
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    const ready = dep.status?.readyReplicas ?? 0, f = state?.flow
    onHover({ title: `${info.emoji} ${info.title}: ${dep.metadata.name}`, lines: [
      role.does,
      ...(state?.affected ? [`${state.affected.icon} Needs attention: ${state.affected.label}`] : []),
      ...(related ? ['Connected to the selection. Potential impact is not proof of measured failure.'] : []),
      `Pods: ${ready} of ${desired} ready${ready < desired ? ' (Kubernetes is fixing it)' : ''}`,
      state?.live ? `Application: ${label(state.live.application)} · Telemetry: ${label(state.live.availability)} · p95 ${latencyText(state.live.metrics?.p95_latency_ms)}`
        : f ? `Requests ${f.basis}: ${describeFlow(f)} · ${SIGNAL[f.signal].icon} ${SIGNAL[f.signal].label}` : 'Requests: no measurements',
      `If it stops: ${role.ifDown}`, 'Click to inspect',
    ], ...at(e) })
  }
  const tag = tagFor(dep, info, state, theme, rolloutOf(dep, pods))
  const size = sizeFor(desired)
  const body = useRef<THREE.Group>(null)
  useFrame((_, dt) => { body.current?.scale.lerp(new THREE.Vector3(size, size, size), Math.min(1, dt * 4)) })
  return (
    <group position={pos}>
      {selected && <Pad w={17} d={17} r={3.5} position={[0, 0.008, -0.6]} color={info.accent} opacity={0.4} />}
      {!selected && related && <Pad w={17} d={17} r={3.5} position={[0, 0.008, -0.6]} color={info.accent} opacity={0.16} />}
      {state?.affected && <Alarm color={state.affected.color} strong={state.affected.rank >= 3 && state.live?.infrastructure !== 'scaled_down'} />}
      <group ref={body} position={[0, 0, -2]} scale={size}>
        <Landmark info={info} glow={glow} theme={theme} />
        {/* One invisible hit-box for hover/click instead of handlers on every part */}
        <mesh position={[0, info.height / 2, -0.5]} visible={false}
          onClick={(e) => { e.stopPropagation(); if (!dragged(e)) onSelect() }}
          onPointerOver={hover} onPointerMove={hover} onPointerOut={() => onHover(null)}>
          <boxGeometry args={[9, info.height, 6]} />
        </mesh>
      </group>
      {Array.from({ length: desired }, (_, i) => <Plot key={i} position={slot(i, total)} empty={i >= sorted.length} theme={theme} />)}
      {sorted.map((p, i) => (
        <Unit key={p.metadata.uid} pod={p} target={slot(i, total)} powerGrid={powerGrid} nodeColor={nodeColors[p.spec.nodeName]} onHover={onHover} />
      ))}
      {claims.map((c, i) => (
        <Tank key={c.metadata.uid} claim={c} index={i} accent={info.accent} theme={theme} onHover={onHover}
          attached={pods.find((p) => !p.metadata.deletionTimestamp && p.spec.volumes?.[0]?.persistentVolumeClaim?.claimName === c.metadata.name)?.metadata.name} />
      ))}
      {/* outside the scaled group: a sprite would inherit its scale */}
      <Tag lines={tag.lines} border={selected ? info.accent : tag.border} position={[0, info.height * size + 0.8, -2]} theme={theme} />
    </group>
  )
}

// ---------- Power Stations (Nodes) ----------

function PowerStation({ node, pos, used, color, theme, onHover, selected, onSelect }: {
  node: K8sObject; pos: THREE.Vector3; used: number; color: string; theme: Theme; onHover: OnHover
  selected: boolean; onSelect: () => void
}) {
  const ready = nodeReady(node)
  const unnoticed = ready && node.metadata.annotations?.['kubeverse.io/power-cut'] === 'true' // cut, heartbeats not yet missed
  const cordoned = !!node.spec?.unschedulable
  const drain: string = node.metadata.annotations?.['kubeverse.io/drain'] ?? ''
  const capacity = Number(node.status?.capacity?.pods ?? 0)
  // Real Nodes report ~110 Pod slots, so the meter shows at most 8 lights, lit in proportion.
  const lights = Math.max(1, Math.min(8, capacity)), lit = capacity ? Math.ceil((used / capacity) * lights) : 0
  const name = node.metadata.name
  const night = theme.mode === 'night'
  const beacon = useRef<THREE.Mesh>(null)
  const smoke = useRef<THREE.Group>(null)
  useFrame(({ clock }) => {
    const t = clock.elapsedTime
    if (beacon.current) beacon.current.visible = (ready && !cordoned) || Math.sin(t * 8) > 0
    smoke.current?.children.forEach((c, i) => {
      const k = (t * 0.3 + i / 3) % 1
      c.position.y = 5 + k * 3.5
      c.scale.setScalar(0.5 + k * 1.1)
      ;((c as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = ready && !unnoticed ? 0.45 * (1 - k) : 0
    })
  })
  const wall = night ? '#7483a0' : '#ece8df'
  const concrete = night ? '#5d6a85' : '#d3cec3'
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHover({
      title: `⚡ Power Station ${name}`,
      lines: ['A Node: a machine that runs Pods.', !ready ? 'POWER CUT: Kubernetes marked it NotReady; its Pods are evicted.'
        : unnoticed ? 'POWER CUT: Kubernetes has not noticed yet. It waits for missed heartbeats.' : cordoned ? `Under maintenance (cordoned): ${drain}.` : `Running ${used} of ${capacity} Pod slots.`,
        'Click for maintenance and power controls.'],
      ...at(e),
    })
  }
  return (
    <group position={pos} scale={0.85}>
      <Pad w={13} d={10.5} r={2.5} position={[0, 0.006, -0.3]} color={selected ? color : theme.district} opacity={selected ? 0.5 : 1} />
      {cordoned && (
        <group position={[-1.2, 0, 4.6]}>
          {/* maintenance barrier: striped boom between two posts */}
          {[-3.4, 3.4].map((x) => <mesh key={x} position={[x, 0.6, 0]}><boxGeometry args={[0.25, 1.2, 0.25]} /><meshStandardMaterial color="#334155" /></mesh>)}
          {[-2.55, -0.85, 0.85, 2.55].map((x, i) => <mesh key={x} position={[x, 1.05, 0]}><boxGeometry args={[1.7, 0.22, 0.12]} /><meshStandardMaterial color={i % 2 ? '#f8fafc' : '#f59e0b'} /></mesh>)}
        </group>
      )}
      <mesh position={[-1.2, 1.5, 1.6]} castShadow receiveShadow><boxGeometry args={[6.4, 3, 3.2]} /><meshStandardMaterial color={wall} /></mesh>
      <mesh position={[-1.2, 3.1, 1.6]}><boxGeometry args={[6.7, 0.22, 3.5]} /><meshStandardMaterial color={color} /></mesh>
      {/* Capacity meter: one light per Pod slot, lit when used */}
      {Array.from({ length: lights }, (_, i) => (
        <mesh key={i} position={[-4.4 + i * (8.4 / lights) + 4.2 / lights, 0.95, 3.23]}>
          <boxGeometry args={[Math.min(0.85, 7.4 / lights), 1.1, 0.06]} />
          <meshBasicMaterial color={ready && i < lit ? color : night ? '#1e293b' : '#94a3b8'} toneMapped={false} />
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
      <mesh ref={beacon} position={[-4.6, 6.2, -2.4]}><sphereGeometry args={[0.22, 10, 8]} /><meshBasicMaterial color={!ready ? RED : cordoned ? AMBER : color} toneMapped={false} /></mesh>
      {[3.6, 4.8].map((x) => <mesh key={x} position={[x, 0.55, 2]} castShadow><boxGeometry args={[0.9, 1.1, 0.9]} /><meshStandardMaterial color={night ? '#55627d' : '#a8b0bc'} /></mesh>)}
      <FacadeSign text="POWER STATION" width={3.8} pos={[-1.2, 2.25, 3.23]} bg={ready ? color : '#7f1d1d'} theme={theme} />
      <mesh position={[0, 2.6, 0]} visible={false} onPointerOver={hover} onPointerMove={hover} onPointerOut={() => onHover(null)}
        onClick={(e) => { e.stopPropagation(); if (!dragged(e)) onSelect() }}>
        <boxGeometry args={[12, 5.2, 9.5]} />
      </mesh>
      <Tag theme={theme} position={[-0.5, 7, 0]} border={ready ? color : RED} size={0.036}
        lines={[{ text: `⚡ ${name}`, px: 56, color: theme.labelFg },
          !ready ? { text: 'POWER CUT · NotReady', px: 40, color: RED }
            : unnoticed ? { text: 'POWER CUT · heartbeats stopping…', px: 40, color: RED }
            : cordoned ? { text: `MAINTENANCE · ${drain.startsWith('blocked') ? 'waiting on a budget' : drain}`, px: 40, color: night ? AMBER : '#b45309' }
              : { text: `Node · ${used}/${capacity} slots used`, px: 40, color: night ? '#cbd5e1' : '#334155' }]} />
    </group>
  )
}

// ---------- Cars ----------

/**
 * Cars are independent drivers (see traffic.ts): they pull out of the caller as requests arrive, follow
 * the Car ahead, slow for bends, and at the callee's door are served, refused (red) or answered with an
 * error (orange). Fate is decided on arrival, from the live state, so Cars already on the road react to failures.
 */
function Traffic({ edge, road, theme, accent, onHover, endpoints, paused, liveMode, previewCount }: {
  edge: RoadFlow; road: StreetRoute; theme: Theme; accent: string; onHover: OnHover
  endpoints: string[]; paused: boolean; liveMode: boolean; previewCount?: number // Pod flashes illustrate distribution, not observed request routing
}) {
  const lorry = crossesDistricts(edge)
  const length = lorry ? 2.4 : DRIVE.length
  const front = lorry ? 1.2 : 0.56, rear = -front
  const lampOffset = lorry ? 0.34 : 0.22
  const preview = previewCount !== undefined
  const dispatched = useRef(0)
  const targets = useRef(endpoints)
  targets.current = endpoints
  const trips = useMemo(() => {
    const ok = new Path(carTrip(road.outbound, false)), back = new Path(carTrip(road.outbound, true, road.inbound))
    return { ok, back, trip: { okLength: ok.length, backLength: back.length, door: Math.max(0, ok.length - CAR_GROW), vehicleLength: length,
      limitOk: bendLimit(ok.pts, GRIP), limitBack: bendLimit(back.pts, GRIP) } }
  }, [road, length])
  const cars = useRef<CarAgent[]>([])
  const credit = useRef(0) // requests waiting to leave as a Car
  useLayoutEffect(() => {
    if (preview) dispatched.current -= cars.current.length
    cars.current = []
    credit.current = 0
  }, [preview, trips])
  const live = useRef(edge)
  live.current = edge
  const pause = useRef(paused)
  useLayoutEffect(() => { pause.current = paused }, [paused])
  const groups = useRef<(THREE.Group | null)[]>([])
  const paints = useRef<(THREE.MeshStandardMaterial | null)[]>([])
  const hazards = useRef<(THREE.Group | null)[]>([])
  const brakes = useRef<(THREE.Group | null)[]>([])
  const tmp = useMemo(() => new THREE.Vector3(), [])
  const colors = useMemo(() => ({ ok: new THREE.Color(accent), refused: new THREE.Color(RED), error: new THREE.Color(ORANGE) }), [accent])
  useFrame(({ clock }, rawDt) => {
    if (pause.current) {
      cars.current = []; credit.current = 0
      groups.current.forEach((g) => { if (g) g.visible = false })
      return
    }
    const dt = Math.min(rawDt, 0.1) // a hidden tab must not dump a burst of Cars
    const now = clock.elapsedTime
    const e = live.current
    // Arrivals at the request rate, jittered; a backlog waits (up to 3) while the caller's exit is blocked.
    const used = new Set(cars.current.map((c) => c.slot))
    const slot = [...Array(CAR_POOL).keys()].find((i) => !used.has(i))
    // MiniShop's manual traffic is much quieter than the simulator. Normalise only the illustration;
    // measured rates are unchanged, and the same pool/exit limits still bound the rendering cost.
    if (slot !== undefined) {
      if (previewCount !== undefined) {
        if (dispatched.current < previewCount && exitClear(cars.current, length)) {
          cars.current.push(newCar(slot, Math.random))
          dispatched.current++
        }
      } else {
        const arrival = admit(credit.current, e.rps, dt, cars.current, Math.random, liveMode ? 1 : CARS_PER_REQUEST, length)
        credit.current = arrival.credit
        if (arrival.leave) cars.current.push(newCar(slot, Math.random))
      }
    }
    const steps = Math.ceil(dt * 60) // small steps keep the car-following stable
    for (let k = 0; k < steps; k++) {
      const r = stepCars(cars.current, dt / steps, now, trips.trip, rates(e))
      if (!preview) for (let n = 0; n < r.served.length; n++) deliver(e.to, targets.current, now)
      cars.current = r.cars
    }
    const blink = Math.sin(now * 12) > 0
    groups.current.forEach((g, i) => {
      if (!g) return
      const car = cars.current.find((c) => c.slot === i)
      g.visible = !!car
      if (!car) return
      const trip = car.phase === 'back' ? trips.back : trips.ok
      g.rotation.y = trip.at(car.s, tmp)
      g.position.copy(tmp)
      g.scale.setScalar(1.15 * Math.max(0.01, Math.min(1, car.s / CAR_GROW, (trip.length - car.s) / CAR_GROW)))
      paints.current[i]?.color.copy(car.fate ? colors[car.fate] : colors.ok)
      if (hazards.current[i]) hazards.current[i]!.visible = !!car.fate && blink
      if (brakes.current[i]) brakes.current[i]!.visible = car.a < -1.5 || (car.v < 0.3 && car.phase !== 'in')
    })
  })
  const [src, dst] = [edge.from.startsWith('ingress:') ? 'customers' : nameOf(edge.from), nameOf(edge.to)]
  const night = theme.mode === 'night'
  const story = (c?: CarAgent) => preview ? 'Illustrated packet from the Demo Control Centre.' : !c ? '' : c.fate === 'refused' ? 'Illustrates the aggregate share of calls with no HTTP answer.'
    : c.fate === 'error' ? 'Illustrates HTTP response errors, including business rejections. This does not establish a root cause.'
      : 'Illustrates normalised aggregate activity; car count, travel time, queuing and Pod flashes are not request-level measurements.'
  return (
    <group>
      {Array.from({ length: CAR_POOL }, (_, i) => (
        <group key={i} visible={false} ref={(g) => { groups.current[i] = g }}
          onPointerOver={(e) => {
            e.stopPropagation()
            const car = cars.current.find((c) => c.slot === i)
            onHover({
              title: `${lorry ? '🚚' : '🚗'} ${preview ? 'Demo packet' : 'Aggregate activity'}: ${src} → ${dst}`,
              lines: preview ? [story(car)] : [story(car), `This route: ${describeFlow(live.current)}.`],
              ...at(e),
            })
          }}
          onPointerOut={() => onHover(null)}>
          {lorry ? <>
            <mesh position={[-0.36, 0.63, 0]} castShadow><boxGeometry args={[1.62, 0.81, 0.92]} /><meshStandardMaterial ref={(m) => { paints.current[i] = m }} color={accent} /></mesh>
            <mesh position={[0.78, 0.47, 0]} castShadow><boxGeometry args={[0.78, 0.64, 0.84]} /><meshStandardMaterial color={night ? '#64748b' : '#f8fafc'} /></mesh>
            <mesh position={[1.176, 0.62, 0]}><boxGeometry args={[0.02, 0.2, 0.68]} /><meshStandardMaterial color="#18273e" /></mesh>
          </> : <>
            <mesh position={[0, 0.3, 0]} castShadow><boxGeometry args={[1.1, 0.35, 0.6]} /><meshStandardMaterial ref={(m) => { paints.current[i] = m }} color={accent} /></mesh>
            <mesh position={[-0.1, 0.6, 0]}><boxGeometry args={[0.6, 0.3, 0.52]} /><meshStandardMaterial color={night ? '#0f172a' : '#e2e8f0'} /></mesh>
          </>}
          {(lorry ? [-0.9, -0.52, 0.78] : [-0.32, 0.32]).map((x) => <mesh key={x} position={[x, 0.14, 0]}>
            <boxGeometry args={lorry ? [0.3, 0.3, 0.98] : [0.26, 0.26, 0.66]} /><meshStandardMaterial color="#111827" /></mesh>)}
          {night && [-lampOffset, lampOffset].map((z) => (
            <mesh key={z} position={[front, 0.32, z]}><boxGeometry args={[0.04, 0.1, 0.12]} /><meshBasicMaterial color="#fef9c3" toneMapped={false} /></mesh>
          ))}
          <group ref={(g) => { brakes.current[i] = g }} visible={false}>
            {[-lampOffset, lampOffset].map((z) => (
              <mesh key={z} position={[rear, 0.22, z]}><boxGeometry args={[0.05, 0.08, 0.12]} /><meshBasicMaterial color="#dc2626" toneMapped={false} /></mesh>
            ))}
          </group>
          <group ref={(g) => { hazards.current[i] = g }} visible={false}>
            {[-lampOffset, lampOffset].map((z) => (
              <mesh key={z} position={[rear, 0.35, z]}><boxGeometry args={[0.06, 0.12, 0.14]} /><meshBasicMaterial color="#fb923c" toneMapped={false} /></mesh>
            ))}
          </group>
        </group>
      ))}
    </group>
  )
}

/** City Hall: the control plane (API server and its record book etcd, the scheduler, the controllers). */
function CityHall({ pos, theme, onHover, selected, onSelect }: {
  pos: THREE.Vector3; theme: Theme; onHover: OnHover; selected: boolean; onSelect: () => void
}) {
  const night = theme.mode === 'night'
  const stone = night ? '#8a97b3' : '#f3efe6', roof = '#475569', accent = '#6366f1'
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHover({ title: '🏛️ City Hall · the control plane', lines: [
      'Where Kubernetes decides. The API server keeps the city\'s records (etcd);',
      'the scheduler and controllers compare desired with actual and send out orders.',
      'Watch the glowing messengers: each one is a decision. Click for the legend.',
    ], ...at(e) })
  }
  return (
    <group position={pos}>
      <Pad w={18} d={13} r={3} position={[0, 0.006, 0]} color={selected ? accent : theme.district} opacity={selected ? 0.45 : 1} />
      <mesh position={[0, 0.2, 0.4]} receiveShadow><boxGeometry args={[12, 0.4, 8]} /><meshStandardMaterial color={stone} /></mesh>
      <mesh position={[0, 0.5, 0.6]}><boxGeometry args={[11, 0.3, 7.4]} /><meshStandardMaterial color={stone} /></mesh>
      <mesh position={[0, 2.4, -0.6]} castShadow><boxGeometry args={[10, 3.6, 4.6]} /><meshStandardMaterial color={stone} /></mesh>
      {[-3.6, -2.2, -0.8, 0.8, 2.2, 3.6].map((x) => (
        <mesh key={x} position={[x, 2.3, 2.3]} castShadow><cylinderGeometry args={[0.25, 0.29, 3.6, 14]} /><meshStandardMaterial color={stone} /></mesh>
      ))}
      <mesh position={[0, 4.4, 0.4]}><boxGeometry args={[10.4, 0.5, 4.8 + 3.2]} /><meshStandardMaterial color={roof} /></mesh>
      <FacadeSign text="CITY HALL" width={3.6} pos={[0, 4.4, 4.42]} bg={accent} theme={theme} />
      {/* clock tower and dome */}
      <mesh position={[0, 6.4, -0.6]} castShadow><boxGeometry args={[2.6, 3.6, 2.6]} /><meshStandardMaterial color={stone} /></mesh>
      <mesh position={[0, 7, 0.72]} rotation-x={Math.PI / 2}><cylinderGeometry args={[0.8, 0.8, 0.06, 24]} /><meshBasicMaterial color={night ? '#fde68a' : '#f8fafc'} toneMapped={false} /></mesh>
      <mesh position={[0, 8.2, -0.6]}><sphereGeometry args={[1.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2]} /><meshStandardMaterial color={accent} /></mesh>
      <mesh position={[0, 10, -0.6]}><cylinderGeometry args={[0.05, 0.05, 1.6, 6]} /><meshStandardMaterial color="#334155" /></mesh>
      <mesh position={[0, 3.2, -0.6]} visible={false} onPointerOver={hover} onPointerMove={hover} onPointerOut={() => onHover(null)}
        onClick={(e) => { e.stopPropagation(); if (!dragged(e)) onSelect() }}>
        <boxGeometry args={[12, 9, 9]} />
      </mesh>
      <Tag theme={theme} position={[0, 11, -0.6]} border={accent} size={0.04}
        lines={[{ text: '🏛️ City Hall', px: 56, color: theme.labelFg }, { text: 'control plane', px: 40, color: night ? '#a5b4fc' : '#4338ca' }]} />
    </group>
  )
}

interface Flight { from: THREE.Vector3; to: THREE.Vector3; color: THREE.Color; t0: number }
const FLIGHT_SECONDS = 1.5
const MESSENGERS = 30

/**
 * Messengers: one glowing orb per control-plane decision, flying through the air (never on a Road)
 * from whoever decided to whoever must act. Colour = the component that reported the event.
 */
function Messengers({ events, place }: { events: K8sObject[]; place: (e: K8sObject) => [THREE.Vector3, THREE.Vector3] | null }) {
  const clock = useThree((s) => s.clock)
  const seen = useRef<Set<string> | null>(null)
  const flights = useRef<(Flight | null)[]>(Array(MESSENGERS).fill(null))
  const orbs = useRef<(THREE.Group | null)[]>([])
  useEffect(() => {
    if (!seen.current) { seen.current = new Set(events.map((e) => e.metadata.uid)); return } // no fly-by for history
    for (const e of events) {
      if (seen.current.has(e.metadata.uid)) continue
      seen.current.add(e.metadata.uid)
      const ends = place(e)
      const color = COMPONENTS[componentOf(e)]?.color
      const free = flights.current.findIndex((f) => !f || clock.elapsedTime - f.t0 > FLIGHT_SECONDS)
      if (ends && color && free >= 0) flights.current[free] = { from: ends[0], to: ends[1], color: new THREE.Color(color), t0: clock.elapsedTime }
    }
  }, [events, place, clock])
  const tmp = useMemo(() => new THREE.Vector3(), [])
  useFrame(() => {
    flights.current.forEach((f, i) => {
      const g = orbs.current[i]
      if (!g) return
      const k = f ? (clock.elapsedTime - f.t0) / FLIGHT_SECONDS : 2
      g.visible = k >= 0 && k <= 1
      if (!f || !g.visible) return
      g.children.forEach((child, j) => {
        const kk = Math.max(0, k - j * 0.05) // the orb, then a short trail
        tmp.lerpVectors(f.from, f.to, kk)
        tmp.y += Math.sin(Math.PI * kk) * (6 + f.from.distanceTo(f.to) * 0.12)
        child.position.copy(tmp)
        ;((child as THREE.Mesh).material as THREE.MeshBasicMaterial).color.copy(f.color)
      })
    })
  })
  return (
    <group>
      {Array.from({ length: MESSENGERS }, (_, i) => (
        <group key={i} visible={false} ref={(g) => { orbs.current[i] = g }}>
          {[0.85, 0.6, 0.4].map((r, j) => (
            <mesh key={j}><sphereGeometry args={[r, 12, 10]} /><meshBasicMaterial transparent opacity={1 - j * 0.3} toneMapped={false} /></mesh>
          ))}
        </group>
      ))}
    </group>
  )
}

/** The City Gate: an Ingress, the city's entrance from the internet, routing a host name to a Service. */
function CityGate({ ingress, pos, healthy, theme, onHover }: {
  ingress: K8sObject; pos: THREE.Vector3; healthy: boolean; theme: Theme; onHover: OnHover
}) {
  const rule = ingress.spec.rules[0]
  const host: string = rule.host, target: string = rule.http.paths[0].backend.service.name
  const night = theme.mode === 'night'
  const stone = night ? '#7483a0' : '#ece8df'
  const accent = healthy ? '#0ea5e9' : RED
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHover({ title: `🌐 City Gate · Ingress ${ingress.metadata.name}`, lines: [
      'The entrance from the internet: customers visiting this address come in here.',
      `${host}/ → the ${target} Service`, healthy ? 'Open: customers are reaching the shop.' : `Customers are turned away: ${target} has no ready Units.`,
    ], ...at(e) })
  }
  return (
    <group position={pos}>
      <Pad w={11} d={9} r={2.5} position={[0, 0.006, 0]} color={theme.district} />
      {[-3.2, 3.2].map((z) => (
        <group key={z} position={[0, 0, z]}>
          <mesh position={[0, 2.6, 0]} castShadow><boxGeometry args={[1.4, 5.2, 1.4]} /><meshStandardMaterial color={stone} /></mesh>
          <mesh position={[0, 5.35, 0]}><boxGeometry args={[1.7, 0.3, 1.7]} /><meshStandardMaterial color={accent} /></mesh>
        </group>
      ))}
      <mesh position={[0, 5.9, 0]} castShadow><boxGeometry args={[1.6, 0.9, 8.2]} /><meshStandardMaterial color={stone} /></mesh>
      <mesh position={[0, 5.9, 0]} rotation-y={Math.PI / 2}><boxGeometry args={[8.25, 0.12, 1.65]} /><meshBasicMaterial color={accent} toneMapped={false} /></mesh>
      <FacadeSign text="CITY GATE" width={4.6} pos={[0.82, 5.9, 0]} bg={accent} theme={theme} rotY={Math.PI / 2} />
      <mesh position={[-1.4, 1.1, 2.3]} castShadow><boxGeometry args={[1.2, 2.2, 1.2]} /><meshStandardMaterial color={stone} /></mesh>
      <mesh position={[-1.4, 1.4, 2.3]}><boxGeometry args={[1.25, 0.6, 1.25]} /><meshStandardMaterial color={night ? '#38bdf8' : '#9cc7e4'} /></mesh>
      <mesh position={[0, 3, 0]} visible={false} onPointerOver={hover} onPointerMove={hover} onPointerOut={() => onHover(null)}>
        <boxGeometry args={[4, 6.5, 9]} />
      </mesh>
      <Tag theme={theme} position={[0, 7.4, 0]} border={accent} size={0.04}
        lines={[{ text: '🌐 City Gate', px: 56, color: theme.labelFg }, { text: `${host} → ${target}`, px: 40, color: healthy ? (night ? '#7dd3fc' : '#0369a1') : RED }]} />
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

/**
 * Flies the camera to the overview or to a selected Building. Isometric: the view direction never
 * changes; flying moves the look-at point and the zoom. 3D: it moves the camera itself.
 */
function CameraRig({ focus, layout, homeTick, mode }: { focus: THREE.Vector3 | null; layout: CityLayout; homeTick: number; mode: ViewMode }) {
  const view = useThree((s) => s.size)
  const fov = useThree((s) => (s.camera as THREE.PerspectiveCamera).fov ?? 45)
  const controls = useThree((s) => s.controls) as unknown as Controls | null
  const flying = useRef(false)
  const goal = useRef({ target: new THREE.Vector3(), zoom: 5, cam: new THREE.Vector3() })
  const fly = (target: THREE.Vector3, zoom: number, offset: THREE.Vector3) => {
    goal.current.target.copy(target)
    goal.current.zoom = zoom
    goal.current.cam.copy(target).add(offset)
    flying.current = true
  }
  const { x0, x1, z0, z1 } = layout.core
  // Overview: the whole core (and the tallest Buildings on it) fits the viewport.
  useEffect(() => {
    const corners = [x0, x1].flatMap((x) => [z0, z1].flatMap((z) => [0, 14].map((y) => new THREE.Vector3(x, y, z))))
    const span = (axis: THREE.Vector3) => { const d = corners.map((c) => c.dot(axis)); return Math.max(...d) - Math.min(...d) }
    const zoom = 0.94 * Math.min(view.width / span(ISO_RIGHT), view.height / span(ISO_UP))
    const wide = Math.max(x1 - x0, (z1 - z0) * 1.5, 40)
    const dist = (wide * 0.62) / (Math.tan((fov * Math.PI) / 360) * Math.min(view.width / view.height, 2))
    fly(new THREE.Vector3((x0 + x1) / 2, 0, (z0 + z1) / 2), zoom, new THREE.Vector3(0, dist * 0.62, dist * 0.78))
  }, [x0, x1, z0, z1, homeTick, mode]) // eslint-disable-line react-hooks/exhaustive-deps
  // Fly-to: look slightly right of the Building so it is not hidden behind the inspect panel.
  useEffect(() => {
    if (!focus) return
    if (mode === 'iso') fly(focus.clone().addScaledVector(ISO_RIGHT, 8).setY(2), view.height / 46, new THREE.Vector3())
    else fly(focus.clone().add(new THREE.Vector3(5, 2, 0)), 1, new THREE.Vector3(6, 19, 24))
  }, [focus, mode]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!controls) return
    const stop = () => { flying.current = false } // the user grabbed the camera
    controls.addEventListener('start', stop)
    return () => controls.removeEventListener('start', stop)
  }, [controls])
  useFrame(({ camera }, dt) => {
    if (!flying.current || !controls) return
    const k = Math.min(1, dt * 2.5)
    controls.target.lerp(goal.current.target, k)
    if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
      camera.position.copy(controls.target).addScaledVector(ISO, CAM_DIST)
      camera.zoom += (goal.current.zoom - camera.zoom) * k
      camera.updateProjectionMatrix()
    } else camera.position.lerp(goal.current.cam, k)
    controls.update()
    const there = (camera as THREE.OrthographicCamera).isOrthographicCamera
      ? Math.abs(camera.zoom - goal.current.zoom) < 0.01 : camera.position.distanceTo(goal.current.cam) < 0.05
    if (controls.target.distanceTo(goal.current.target) < 0.05 && there) flying.current = false
  })
  return null
}

// ---------- the City ----------

const DEMO_DEPOT = 'demo-transit/depot'

function demoRoutes(workloads: string[], calls: Call[], packets: ClusterState['demoPackets']) {
  const source = workloads.find((key) => key === 'minishop/minishop-web') ?? workloads[0]
  const valid = calls.filter(({ from, to }) => workloads.includes(from) && workloads.includes(to))
  const localTarget = source && workloads.find((to) => to !== source && !crossesDistricts({ from: source, to }))
  const local = valid.find(({ from, to }) => from === source && to === 'minishop/product-api') ??
    valid.find((call) => !crossesDistricts(call)) ?? (source && localTarget ? { from: source, to: localTarget } : undefined)
  const cross = valid.find(crossesDistricts) ?? (source && {
    from: source, to: workloads.find((to) => crossesDistricts({ from: source, to })) ?? DEMO_DEPOT,
  })
  return [
    ...(packets?.cars && local ? [{ call: local, count: packets.cars }] : []),
    ...(packets?.lorries && cross ? [{ call: cross, count: packets.lorries }] : []),
  ]
}

function addDemoDepot(layout: CityLayout): CityLayout {
  const x = layout.core.x1 + 28, z = (layout.core.z0 + layout.core.z1) / 2
  return { ...layout,
    lots: { ...layout.lots, [DEMO_DEPOT]: { key: DEMO_DEPOT, center: new THREE.Vector3(x, 0, z) } },
    districts: [...layout.districts, { name: 'demo-transit', x0: x - 11, x1: x + 11, z0: z - 11, z1: z + 11 }],
    core: { ...layout.core, x1: x + 14 },
  }
}

export function City({ cluster, selected, onSelect, powerGrid, theme, onHover, states, homeTick, flows, replay, mode, trafficPaused, discoveredRoads }: {
  flows: RoadFlow[]; replay: boolean; mode: ViewMode; trafficPaused: boolean
  discoveredRoads?: ReadonlySet<string>
  cluster: ClusterState; selected: string | null; onSelect: (key: string | null) => void
  powerGrid: boolean; theme: Theme; onHover: OnHover; states: ServiceState; homeTick: number
}) {
  const all = Object.values(cluster.objects)
  const deployments = all.filter(isWorkload)
  const pods = all.filter((o) => o.kind === 'Pod')
  const nodes = all.filter((o) => o.kind === 'Node').sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const nodeColors = Object.fromEntries(nodes.map((n, i) => [n.metadata.name, NODE_COLORS[i % NODE_COLORS.length]]))
  // Keyed on names and from→to pairs only: failures change rps/health, and the city must not rearrange.
  const workloadKeys = deployments.map(keyOf).sort()
  const reportedKeys = new Set(cluster.edges.map(roadKey))
  // A backend restart can forget learned relationships while this browser still remembers them.
  const remembered = [...(discoveredRoads ?? [])].filter((key) => !reportedKeys.has(key)).map((key) => {
    const [from, to] = key.split('>')
    return { from, to }
  })
  const { known, supplemental } = cluster.metrics ? miniShopLayoutCalls([...cluster.edges, ...remembered], workloadKeys)
    : { known: cluster.edges, supplemental: [] }
  const layoutKey = [workloadKeys, nodes.map((n) => n.metadata.name), known.map(roadKey).sort()].join('|')
  const previews = demoRoutes(workloadKeys, [...known, ...supplemental], cluster.demoPackets)
  const usesDepot = previews.some(({ call }) => call.to === DEMO_DEPOT)
  const networkCalls = [...supplemental, ...previews.map(({ call }) => call)]
  const supplementalKey = [...new Set(networkCalls.map(roadKey))].sort().join(',')
  const baseLayout = useMemo(() => layoutCity(deployments.map((d) => ({ namespace: d.metadata.namespace!, name: d.metadata.name })),
    nodes.map((n) => n.metadata.name), known, known.filter((c) => c.from.startsWith('ingress:'))),
  [layoutKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const layout = useMemo(() => usesDepot ? addDemoDepot(baseLayout) : baseLayout, [baseLayout, usesDepot])
  const { network, obstacles, lamps, keep } = useMemo(() => {
    const network = buildStreetNetwork(layout, known, networkCalls)
    const lots = [...Object.values(layout.lots), ...Object.values(layout.stations), ...Object.values(layout.gates), ...(layout.hall ? [layout.hall] : [])]
    const clear = (p: THREE.Vector3) => lots.every((l) => Math.abs(p.x - l.center.x) > BUILDING.halfW + 1 ||
      p.z < l.center.z + BUILDING.back - 1 || p.z > l.center.z + BUILDING.front + 1)
    const sample = (points: THREE.Vector3[], gap: number, start: number, end: number) => {
      const path = new Path(points), samples: THREE.Vector3[] = []
      for (let s = start; s < path.length - end; s += gap) {
        const p = new THREE.Vector3()
        path.at(s, p)
        samples.push(p)
      }
      return samples
    }
    const lamps = network.segments.map(({ calls, points, highway }) => ({ calls,
      points: sample(offsetPath(points, -((highway ? HIGHWAY_WIDTH : ROAD_W) / 2 + KERB + 0.3)), 9, 5, 5).filter(clear),
    }))
    const obstacles = [
      ...Object.values(layout.lots).map((l) => ({ x: l.center.x, z: l.center.z - 0.4, rad: 9.5 })),
      ...Object.values(layout.stations).map((l) => ({ x: l.center.x, z: l.center.z, rad: 8 })),
      ...Object.values(layout.gates).map((l) => ({ x: l.center.x, z: l.center.z, rad: 7 })),
      ...(layout.hall ? [{ x: layout.hall.center.x, z: layout.hall.center.z, rad: 11 }] : []),
      ...network.segments.flatMap(({ points, highway }) => sample(points, 3, 0, 0).map(({ x, z }) => ({ x, z, rad: (highway ? HIGHWAY_WIDTH : ROAD_W) / 2 + KERB + 1.2 }))),
      ...network.roundabouts.map(({ center: { x, z } }) => ({ x, z, rad: ROUNDABOUT_RADIUS + ROAD_W / 2 + KERB + 1.2 })),
    ]
    const box = (c: THREE.Vector3, r: number) => ({ x0: c.x - r, x1: c.x + r, z0: c.z - r, z1: c.z + r })
    const keep = [
      ...layout.districts.map((d) => ({ x0: d.x0 + 3, x1: d.x1 - 3, z0: d.z0 + 3, z1: d.z1 - 3 })),
      ...lots.filter((l) => !layout.lots[l.key]).map((l) => box(l.center, 8)),
    ]
    return { network, obstacles, lamps, keep }
  }, [layout, supplementalKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const edges = flows.filter((edge) => network.routes[roadKey(edge)] && roadVisible(edge, discoveredRoads))
  const flowsByKey = new Map(edges.map((edge) => [roadKey(edge), edge]))
  const visibleUses = new Map<string, StreetUse>([...known, ...supplemental].filter((call) => roadVisible(call, discoveredRoads))
    .map((call) => [roadKey(call), { call, edge: flowsByKey.get(roadKey(call)) }]))
  for (const { call } of previews) if (!visibleUses.has(roadKey(call))) visibleUses.set(roadKey(call), { call, preview: true })
  const visibleKeys = [...visibleUses.keys()].sort().join(',')
  const highwayZ = network.segments.reduce((z, segment) => segment.highway && segment.calls.some((key) => visibleUses.has(key))
    ? Math.max(z, segment.points[0].z + HIGHWAY_WIDTH) : z, layout.core.z1)
  const cameraLayout = { ...layout, core: { ...layout.core, z1: highwayZ } }
  const visibleLamps = useMemo(() => lamps.filter(({ calls }) => calls.some((key) => visibleUses.has(key)))
    .flatMap(({ points }) => points), [lamps, visibleKeys]) // eslint-disable-line react-hooks/exhaustive-deps
  const related = new Set(flows.filter((e) => e.from === selected || e.to === selected).flatMap((e) => [e.from, e.to]))
  const focus = !selected ? null : selected === 'city-hall' ? layout.hall?.center ?? null
    : selected.startsWith('node:') ? layout.stations[selected.slice(5)]?.center ?? null : layout.lots[selected]?.center ?? null
  const podsOn = (node: string) => pods.filter((p) => p.spec.nodeName === node && !p.metadata.deletionTimestamp).length
  const ready = deployments.length > 0
  const ingresses = all.filter((o) => o.kind === 'Ingress')
  const claims = all.filter((o) => o.kind === 'PersistentVolumeClaim').sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const events = all.filter((o) => o.kind === 'Event')
  // Where each control-plane decision flies from and to.
  const objects = cluster.objects
  const place = useCallback((e: K8sObject): [THREE.Vector3, THREE.Vector3] | null => {
    const lift = (v: THREE.Vector3 | undefined, y: number) => v?.clone().add(new THREE.Vector3(0, y, 0))
    const hall = lift(layout.hall?.center, 9)
    const station = (n?: string) => lift(n ? layout.stations[n]?.center : undefined, 6)
    const io = e.involvedObject
    if (!io) return null
    const podApp = (name: string) => Object.values(objects).find((o) => o.kind === 'Pod' && o.metadata.name === name)?.metadata.labels?.app ?? name
    // A ReplicaSet (frontend-7c5d9b8f4d) or Pod (frontend-7c5d9b8f4d-x2kqp, postgres-0) belongs to the
    // workload whose name is its longest prefix.
    const owner = (name: string) => Object.values(objects).filter((o) => isWorkload(o) && o.metadata.namespace === io.namespace &&
      (name === o.metadata.name || name.startsWith(`${o.metadata.name}-`))).sort((a, b) => b.metadata.name.length - a.metadata.name.length)[0]?.metadata.name
    const building = (name: string) => lift(layout.lots[`${io.namespace}/${owner(name) ?? name}`]?.center, 4)
    const target = io.kind === 'Node' ? station(io.name) : io.kind === 'Pod' ? building(podApp(io.name)) : building(io.name)
    const component = componentOf(e)
    let from = hall, to = target
    if (component === 'kubelet') { from = station(e.reportingInstance || e.source?.host || undefined); to = io.kind === 'Node' ? hall : target }
    if (e.reason === 'Scheduled') to = station(/ to (\S+)$/.exec(e.message ?? '')?.[1])
    return from && to ? [from, to] : null
  }, [layout, objects])
  // A Service's endpoints are its ready Pods: the only ones that receive requests.
  const endpoints = (service: string) => {
    const dep = deployments.find((d) => keyOf(d) === service)
    return dep ? podsOf(dep, pods).filter((p) => !p.metadata.deletionTimestamp && p.status?.containerStatuses?.[0]?.ready).map((p) => p.metadata.uid) : []
  }

  return (
    <Canvas shadows onPointerMissed={() => onSelect(null)}>
      {mode === 'iso'
        ? <OrthographicCamera key="camera-iso" makeDefault position={ISO.clone().multiplyScalar(CAM_DIST).toArray()} zoom={5} near={1} far={1200} />
        : <PerspectiveCamera key="camera-3d" makeDefault position={[0, 60, 80]} fov={45} near={1} far={900} />}
      <color attach="background" args={[theme.sky]} />
      {/* Isometric fog starts beyond the look-at point, so only the far edge of the ground fades. */}
      <fog attach="fog" args={mode === 'iso' ? [theme.sky, CAM_DIST + theme.fog[0] - 30, CAM_DIST + theme.fog[1]] : [theme.sky, ...theme.fog]} />
      <ambientLight intensity={theme.ambient} />
      <hemisphereLight args={[theme.sky, theme.ground, theme.ambient * 0.5]} />
      <directionalLight position={[30, 45, 25]} intensity={theme.sun} color={theme.sunColor} castShadow
        shadow-mapSize={[2048, 2048]} shadow-camera-left={-80} shadow-camera-right={80} shadow-camera-top={80} shadow-camera-bottom={-80} shadow-camera-far={220}
        shadow-bias={-0.0004} shadow-normalBias={0.04} />
      <Ground layout={layout} theme={theme} />
      {ready && <Scenery core={layout.core} districts={layout.districts} obstacles={obstacles} keep={keep} theme={theme} />}
      {ready && <Lamps points={visibleLamps} theme={theme} />}
      {network.segments.map(({ key, points, calls, highway }) => {
        const uses = calls.flatMap((id) => visibleUses.get(id) ?? [])
        return uses.length > 0 && <Road key={key} pts={points} uses={uses} highway={highway} selected={selected} theme={theme} onHover={onHover} />
      })}
      {network.roundabouts.filter(({ calls }) => calls.some((key) => visibleUses.has(key))).map((junction) => (
        <RoundaboutMesh key={junction.key} center={junction.center} theme={theme} />
      ))}
      {nodes.map((n) => layout.stations[n.metadata.name] && (
        <PowerStation key={n.metadata.uid} node={n} pos={layout.stations[n.metadata.name].center} used={podsOn(n.metadata.name)}
          color={nodeColors[n.metadata.name]} theme={theme} onHover={onHover}
          selected={selected === `node:${n.metadata.name}`} onSelect={() => onSelect(`node:${n.metadata.name}`)} />
      ))}
      {layout.hall && <CityHall pos={layout.hall.center} theme={theme} onHover={onHover}
        selected={selected === 'city-hall'} onSelect={() => onSelect('city-hall')} />}
      <Messengers events={events} place={place} />
      {ingresses.map((ing) => {
        const key = `ingress:${ing.metadata.namespace}/${ing.metadata.name}`
        const gate = layout.gates[key]
        return gate && <CityGate key={ing.metadata.uid} ingress={ing} pos={gate.center} theme={theme} onHover={onHover}
          healthy={flows.find((e) => e.from === key)?.healthy ?? true} />
      })}
      {deployments.map((dep) => {
        const key = keyOf(dep)
        const lot = layout.lots[key]
        if (!lot) return null
        return (
          <Building key={key} dep={dep} info={landmarkFor(dep.metadata.name)} pos={lot.center}
            selected={selected === key} onSelect={() => onSelect(key)} powerGrid={powerGrid} nodeColors={nodeColors}
            related={selected !== key && related.has(key)}
            theme={theme} onHover={onHover} state={states[key]}
            pods={podsOf(dep, pods)}
            claims={claims.filter((c) => c.metadata.namespace === dep.metadata.namespace && c.metadata.labels?.app === dep.metadata.name)} />
        )
      })}
      {usesDepot && <group position={layout.lots[DEMO_DEPOT].center}>
        <Pad w={14} d={12} r={2} position={[0, 0.008, 0]} color={theme.district} />
        <mesh position-y={1.9} castShadow><boxGeometry args={[9, 3.8, 7]} /><meshStandardMaterial color="#92735e" /></mesh>
        <mesh position-y={3.9} castShadow><boxGeometry args={[10, 0.35, 8]} /><meshStandardMaterial color="#4b5563" /></mesh>
        <Tag theme={theme} position={[0, 6, 0]} border={theme.roadGlow} lines={[{ text: 'Demo depot', px: 48, color: theme.labelFg }]} />
      </group>}
      {previews.map(({ call, count }) => {
        const key = roadKey(call), road = network.routes[key]
        return road && <Traffic key={`preview:${key}:${cluster.demoPackets?.reset}`} edge={{ ...call, rps: 0, healthy: true }}
          road={road} theme={theme} accent="#d6a53b" onHover={onHover} endpoints={[]} paused={false} liveMode={false} previewCount={count} />
      })}
      {edges.map((e) => {
        if (replay && !e.measured) return null // replaying history: only routes with recorded traffic get Cars
        // A Car wears its caller's colour (customers: yellow taxis); how its request went shows at the door.
        return <Traffic key={roadKey(e)} edge={e} road={network.routes[roadKey(e)]} theme={theme} onHover={onHover}
          accent={e.from.startsWith('ingress:') ? CUSTOMER : landmarkFor(nameOf(e.from)).accent} endpoints={endpoints(e.to)} paused={trafficPaused} liveMode={typeof cluster.context === 'string'} />
      })}
      {mode === 'iso'
        // Isometric: no rotation. Drag (or one finger) pans, wheel (or pinch) zooms towards the cursor.
        ? <OrbitControls key="controls-iso" makeDefault enableRotate={false} screenSpacePanning zoomToCursor minZoom={1.5} maxZoom={60}
          mouseButtons={{ LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }}
          touches={{ ONE: THREE.TOUCH.PAN, TWO: THREE.TOUCH.DOLLY_PAN }} />
        // 3D: drag orbits, right-drag pans, wheel zooms; the camera never goes below the ground.
        : <OrbitControls key="controls-3d" makeDefault maxPolarAngle={Math.PI / 2.15} minDistance={10} maxDistance={170} />}
      <CameraRig focus={focus} layout={cameraLayout} homeTick={homeTick} mode={mode} />
    </Canvas>
  )
}
