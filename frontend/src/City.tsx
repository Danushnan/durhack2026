import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { Edges, OrbitControls } from '@react-three/drei'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import {
  api, type ClusterState, type Edge, type K8sObject, deploymentHealth, describePod, HEALTH_COLOR,
  keyOf, NODE_COLORS, podStatus, STATUS_COLOR,
} from './k8s'
import { FacadeSign, Landmark, type LandmarkInfo, landmarkFor } from './landmarks'
import { type CityLayout, checkRoutes, DRIVEWAY_X, laneOffset, layoutCity, LOT, Path, routeBetween, STREET_W } from './layout'
import { Scenery } from './scenery'
import { nameOf, roleOf } from './teach'
import { textTexture, type TextLine } from './textures'
import type { Theme } from './theme'

export interface HoverInfo { title: string; lines: string[]; x: number; y: number }
type OnHover = (h: HoverInfo | null) => void
/** Per-service state the City needs for labelling: down, or impacted via a chain of dependencies. */
export type ServiceState = Record<string, { down: boolean; chain: string[] | null }>

const UNIT = 0.9
const UNIT_GAP = 1.25
const UNIT_COLS = 6
const CAR_SPEED = 6 // world units per second
const PARK_SECONDS = 1.2
const AMBER = '#f59e0b'

const at = (e: ThreeEvent<PointerEvent>) => ({ x: e.nativeEvent.clientX, y: e.nativeEvent.clientY })

// ---------- floating name tags (canvas sprites: no DOM, so they never fight the camera) ----------

function Tag({ lines, border, position, height = 1.7, theme }: {
  lines: TextLine[]; border: string; position: [number, number, number]; height?: number; theme: Theme
}) {
  const key = JSON.stringify(lines) + border + theme.mode
  const { texture, aspect } = useMemo(() => textTexture(lines, { bg: theme.labelBg, border }), [key]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => texture.dispose(), [texture])
  return (
    <sprite position={position} scale={[height * aspect, height, 1]} renderOrder={10}>
      <spriteMaterial map={texture} depthTest={false} transparent />
    </sprite>
  )
}

// ---------- ground, streets, districts ----------

function Ground({ layout, theme }: { layout: CityLayout; theme: Theme }) {
  const { x0, x1, z0, z1 } = layout.extent
  const len = (a: number, b: number) => b - a + STREET_W
  const inner = LOT - STREET_W
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[(x1 - x0) * 4, (z1 - z0) * 4]} />
        <meshStandardMaterial color={theme.ground} />
      </mesh>
      {[...layout.scenery, ...Object.values(layout.stations)].map((l) => (
        <mesh key={`${l.col},${l.row}`} rotation-x={-Math.PI / 2} position={[l.center.x, 0.004, l.center.z]} receiveShadow>
          <planeGeometry args={[inner, inner]} /><meshStandardMaterial color={theme.lot} />
        </mesh>
      ))}
      {layout.districts.map((dist) => (
        <group key={dist.name}>
          <mesh rotation-x={-Math.PI / 2} position={[(dist.x0 + dist.x1) / 2, 0, (dist.z0 + dist.z1) / 2]} receiveShadow>
            <planeGeometry args={[dist.x1 - dist.x0, dist.z1 - dist.z0]} />
            <meshStandardMaterial color={theme.district} />
          </mesh>
          <mesh position={[dist.x0 + 2, 1.4, dist.z0 + 2]}><cylinderGeometry args={[0.08, 0.08, 2.8, 8]} /><meshStandardMaterial color="#64748b" /></mesh>
          <FacadeSign text={`${dist.name.toUpperCase()} DISTRICT`} width={4.4} pos={[dist.x0 + 2, 3, dist.z0 + 2.1]} bg="#15803d" theme={theme} />
        </group>
      ))}
      {layout.streetsX.map((x) => (
        <group key={`x${x}`}>
          <mesh rotation-x={-Math.PI / 2} position={[x, 0.01, 0]} receiveShadow>
            <planeGeometry args={[STREET_W, len(z0, z1)]} /><meshStandardMaterial color={theme.street} />
          </mesh>
          <mesh rotation-x={-Math.PI / 2} position={[x, 0.02, 0]}>
            <planeGeometry args={[0.08, len(z0, z1)]} /><meshBasicMaterial color={theme.marking} />
          </mesh>
        </group>
      ))}
      {layout.streetsZ.map((z) => (
        <group key={`z${z}`}>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.011, z]} receiveShadow>
            <planeGeometry args={[len(x0, x1), STREET_W]} /><meshStandardMaterial color={theme.street} />
          </mesh>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.021, z]}>
            <planeGeometry args={[len(x0, x1), 0.08]} /><meshBasicMaterial color={theme.marking} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

// ---------- Buildings, Units, Plots ----------

function slot(i: number): THREE.Vector3 {
  return new THREE.Vector3(-5.6 + (i % UNIT_COLS) * UNIT_GAP, UNIT / 2, 3 + Math.floor(i / UNIT_COLS) * UNIT_GAP)
}

function Unit({ pod, index, powerGrid, nodeColor, onHover }: {
  pod: K8sObject; index: number; powerGrid: boolean; nodeColor?: string; onHover: OnHover
}) {
  const status = podStatus(pod)
  const ref = useRef<THREE.Mesh>(null)
  const mat = useRef<THREE.MeshStandardMaterial>(null)
  const target = slot(index)
  const color = powerGrid ? nodeColor ?? '#64748b' : STATUS_COLOR[status]
  useFrame(({ clock }, dt) => {
    if (ref.current) ref.current.position.lerp(target, Math.min(1, dt * 6)) // slide, don't jump
    if (mat.current) {
      const pulse = status === 'CrashLoopBackOff' || status === 'ContainerCreating'
      mat.current.emissiveIntensity = pulse ? 0.3 + 0.7 * Math.abs(Math.sin(clock.elapsedTime * 4)) : 0.6
    }
  })
  const dim = status === 'Terminating' || status === 'Pending'
  return (
    <mesh ref={ref} position={[target.x, 3, target.z]} castShadow
      onPointerOver={(e) => { e.stopPropagation(); onHover({ title: `Unit ${pod.metadata.name}`, lines: [describePod(pod), `Pod · ${status}`, `Runs on: ${pod.spec.nodeName ?? 'no Node yet'}`], ...at(e) }) }}
      onPointerOut={() => onHover(null)}>
      <boxGeometry args={[UNIT, UNIT, UNIT]} />
      <meshStandardMaterial ref={mat} color={color} emissive={color} transparent opacity={dim ? 0.4 : 1} />
    </mesh>
  )
}

function Plot({ index, color }: { index: number; color: string }) {
  const p = slot(index)
  return (
    <mesh position={[p.x, 0.03, p.z]}>
      <boxGeometry args={[UNIT, 0.04, UNIT]} />
      <meshBasicMaterial transparent opacity={0.08} color={color} />
      <Edges color={color} />
    </mesh>
  )
}

function tagFor(dep: K8sObject, info: LandmarkInfo, state: ServiceState[string] | undefined, theme: Theme): { lines: TextLine[]; border: string } {
  const ready = dep.status.readyReplicas ?? 0, want = dep.spec.replicas
  const health = deploymentHealth(dep)
  const title: TextLine = { text: `${info.emoji} ${dep.metadata.name}`, px: 56, color: theme.labelFg }
  if (state?.down) return { lines: [title, { text: `DOWN · ${ready}/${want} ready`, px: 40, color: '#ef4444' }], border: '#ef4444' }
  if (state?.chain) return { lines: [title, { text: `⚠ IMPACTED · needs ${nameOf(state.chain[state.chain.length - 1])}`, px: 40, color: AMBER }], border: AMBER }
  const color = health === 'healthy' ? (theme.mode === 'night' ? '#4ade80' : '#15803d') : AMBER
  return { lines: [title, { text: `${info.title} · ${ready}/${want} ready`, px: 40, color }], border: HEALTH_COLOR[health] }
}

function Building({ dep, info, pods, pos, selected, onSelect, powerGrid, nodeColors, theme, onHover, state }: {
  dep: K8sObject; info: LandmarkInfo; pods: K8sObject[]; pos: THREE.Vector3; selected: boolean; onSelect: () => void
  powerGrid: boolean; nodeColors: Record<string, string>; theme: Theme; onHover: OnHover; state?: ServiceState[string]
}) {
  const health = deploymentHealth(dep)
  const desired: number = dep.spec.replicas
  const sorted = [...pods].sort((a, b) => (a.metadata.creationTimestamp ?? '').localeCompare(b.metadata.creationTimestamp ?? ''))
  const plots = Math.max(0, desired - sorted.filter((p) => !p.metadata.deletionTimestamp).length)
  const glow = state?.chain && health === 'healthy' ? AMBER : HEALTH_COLOR[health]
  const role = roleOf(dep.metadata.name)
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHover({ title: `${info.emoji} ${info.title}: ${dep.metadata.name}`, lines: [role.does, `If it stops: ${role.ifDown}`, 'Click to inspect'], ...at(e) })
  }
  const tag = tagFor(dep, info, state, theme)
  return (
    <group position={pos}>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.006, 0]} receiveShadow>
        <planeGeometry args={[LOT - STREET_W, LOT - STREET_W]} />
        <meshStandardMaterial color={selected ? info.accent : theme.district} transparent opacity={selected ? 0.35 : 1} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[DRIVEWAY_X, 0.012, LOT / 2 - STREET_W]}>
        <planeGeometry args={[1.8, STREET_W]} /><meshStandardMaterial color={theme.street} />
      </mesh>
      <group position={[0, 0, -2]}>
        <Landmark info={info} glow={glow} theme={theme} />
        {/* One invisible hit-box for hover/click instead of handlers on every part */}
        <mesh position={[0, info.height / 2, -0.5]} visible={false}
          onClick={(e) => { e.stopPropagation(); onSelect() }}
          onPointerOver={hover} onPointerMove={hover} onPointerOut={() => onHover(null)}>
          <boxGeometry args={[9, info.height, 6]} />
        </mesh>
      </group>
      {sorted.map((p, i) => (
        <Unit key={p.metadata.uid} pod={p} index={i} powerGrid={powerGrid} nodeColor={nodeColors[p.spec.nodeName]} onHover={onHover} />
      ))}
      {Array.from({ length: plots }, (_, i) => <Plot key={`plot${i}`} index={sorted.length + i} color={theme.marking} />)}
      <Tag lines={tag.lines} border={selected ? info.accent : tag.border} position={[0, info.height + 1.6, -2]} theme={theme} />
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
      const k = (t * 0.35 + i / 3) % 1
      c.position.y = 5.8 + k * 4
      c.scale.setScalar(0.6 + k * 1.4)
      ;((c as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = ready ? 0.5 * (1 - k) : 0
    })
  })
  const wall = night ? '#4b5568' : '#e5e2da'
  const concrete = night ? '#3b4252' : '#c9c5bb'
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
    <group position={pos}>
      <mesh position={[-1.5, 1.6, 1]} castShadow receiveShadow><boxGeometry args={[6, 3.2, 3.4]} /><meshStandardMaterial color={wall} /></mesh>
      <mesh position={[-1.5, 3.3, 1]}><boxGeometry args={[6.2, 0.2, 3.6]} /><meshStandardMaterial color={color} /></mesh>
      {/* Capacity meter: one light per Pod slot, lit when used */}
      {Array.from({ length: capacity }, (_, i) => (
        <mesh key={i} position={[-3.8 + i * 1.0, 1.1, 2.73]}>
          <boxGeometry args={[0.7, 1.2, 0.06]} />
          <meshBasicMaterial color={ready && i < used ? color : night ? '#1e293b' : '#64748b'} toneMapped={false} />
        </mesh>
      ))}
      {[[2.4, -2.2], [-1.4, -2.9]].map(([x, z]) => (
        <mesh key={x} position={[x, 2.9, z]} castShadow><cylinderGeometry args={[1.1, 1.7, 5.8, 20]} /><meshStandardMaterial color={concrete} /></mesh>
      ))}
      <group ref={smoke}>
        {[0, 1, 2].map((i) => (
          <mesh key={i} position={[2.4, 6, -2.2]}><sphereGeometry args={[0.9, 10, 8]} /><meshStandardMaterial color="#e2e8f0" transparent opacity={0.4} depthWrite={false} /></mesh>
        ))}
      </group>
      <mesh position={[-4.3, 3.6, -2.6]} castShadow><cylinderGeometry args={[0.28, 0.36, 7.2, 12]} /><meshStandardMaterial color={concrete} /></mesh>
      {[5.6, 6.6].map((y) => <mesh key={y} position={[-4.3, y, -2.6]}><cylinderGeometry args={[0.31, 0.31, 0.35, 12]} /><meshStandardMaterial color="#dc2626" /></mesh>)}
      <mesh ref={beacon} position={[-4.3, 7.4, -2.6]}><sphereGeometry args={[0.22, 10, 8]} /><meshBasicMaterial color={ready ? color : '#ef4444'} toneMapped={false} /></mesh>
      {[2.4, 3.6].map((x) => <mesh key={x} position={[x, 0.6, 1.6]} castShadow><boxGeometry args={[0.9, 1.2, 0.9]} /><meshStandardMaterial color={night ? '#334155' : '#9ca3af'} /></mesh>)}
      <mesh position={[3, 1.8, 0.4]}><boxGeometry args={[0.1, 3.6, 0.1]} /><meshStandardMaterial color="#64748b" /></mesh>
      <mesh position={[3, 3.4, 0.4]}><boxGeometry args={[2.2, 0.08, 0.08]} /><meshStandardMaterial color="#64748b" /></mesh>
      <FacadeSign text="POWER STATION" width={3.6} pos={[-1.5, 2.55, 2.73]} bg={ready ? color : '#7f1d1d'} theme={theme} />
      <mesh position={[0, 3, 0]} visible={false} onPointerOver={hover} onPointerMove={hover} onPointerOut={() => onHover(null)}
        onClick={(e) => { e.stopPropagation(); onHover(null); api.outage(name, ready) }}>
        <boxGeometry args={[10, 6, 9]} />
      </mesh>
      <Tag theme={theme} position={[-1.5, 9.4, 0]} border={ready ? color : '#ef4444'}
        lines={[{ text: `⚡ ${name}`, px: 56, color: theme.labelFg },
          ready ? { text: `Node · ${used}/${capacity} slots used`, px: 40, color: night ? '#cbd5e1' : '#334155' }
            : { text: 'POWER CUT', px: 40, color: '#ef4444' }]} />
    </group>
  )
}

// ---------- Cars ----------

function Car({ color, theme, hazards }: { color: string; theme: Theme; hazards: boolean }) {
  const lights = useRef<THREE.Group>(null)
  useFrame(({ clock }) => {
    if (lights.current) lights.current.visible = hazards && Math.sin(clock.elapsedTime * 12) > 0
  })
  return (
    <group>
      <mesh position={[0, 0.3, 0]} castShadow><boxGeometry args={[1.1, 0.35, 0.6]} /><meshStandardMaterial color={color} /></mesh>
      <mesh position={[-0.1, 0.6, 0]}><boxGeometry args={[0.6, 0.3, 0.52]} /><meshStandardMaterial color={theme.mode === 'night' ? '#0f172a' : '#cbd5e1'} /></mesh>
      {theme.headlights && [-0.18, 0.18].map((z) => (
        <mesh key={z} position={[0.56, 0.32, z]}><boxGeometry args={[0.04, 0.1, 0.12]} /><meshBasicMaterial color="#fef9c3" /></mesh>
      ))}
      <group ref={lights}>
        {[-0.22, 0.22].map((z) => (
          <mesh key={z} position={[-0.56, 0.35, z]}><boxGeometry args={[0.06, 0.12, 0.14]} /><meshBasicMaterial color="#fb923c" /></mesh>
        ))}
      </group>
    </group>
  )
}

function Traffic({ edge, layout, theme, accent, onHover }: {
  edge: Edge; layout: CityLayout; theme: Theme; accent: string; onHover: OnHover
}) {
  const { fwd, back } = useMemo(() => {
    const centre = routeBetween(layout, edge.from, edge.to)
    return { fwd: new Path(laneOffset(centre)), back: new Path(laneOffset([...centre].reverse())) }
  }, [layout, edge.from, edge.to])
  const count = Math.ceil(edge.rps)
  const refs = useRef<(THREE.Group | null)[]>([])
  const tmp = useMemo(() => new THREE.Vector3(), [])
  const L = fwd.length
  // Healthy: drive, park at the door, vanish. Failed: drive to the door, pause, turn back.
  const cycle = edge.healthy ? L + CAR_SPEED * PARK_SECONDS : 2 * L + CAR_SPEED * 0.4
  useFrame(({ clock }) => {
    refs.current.forEach((g, i) => {
      if (!g) return
      const d = ((clock.elapsedTime * CAR_SPEED) + (i / count) * cycle) % cycle
      let heading
      if (d <= L) heading = fwd.at(d, tmp)
      else if (edge.healthy || d <= L + CAR_SPEED * 0.4) heading = fwd.at(L, tmp)
      else heading = back.at(d - L - CAR_SPEED * 0.4, tmp)
      g.position.copy(tmp)
      g.rotation.y = heading
    })
  })
  const color = edge.healthy ? accent : '#ef4444'
  const [src, dst] = [nameOf(edge.from), nameOf(edge.to)]
  return (
    <group>
      {Array.from({ length: count }, (_, i) => (
        <group key={i} ref={(g) => { refs.current[i] = g }}
          onPointerOver={(e) => { e.stopPropagation(); onHover({ title: `🚗 Request: ${src} → ${dst}`, lines: [edge.healthy ? 'Delivered successfully.' : `Failed: ${dst} has no working Units, so the car turns back.`, `${edge.rps} requests/second on this route.`], ...at(e) }) }}
          onPointerOut={() => onHover(null)}>
          <Car color={color} theme={theme} hazards={!edge.healthy} />
        </group>
      ))}
    </group>
  )
}

// ---------- camera: intro and fly-to ----------

interface Controls extends THREE.EventDispatcher<{ start: object }> { target: THREE.Vector3; update(): void }

function CameraRig({ focus, home }: { focus: THREE.Vector3 | null; home: THREE.Vector3 }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as Controls | null
  const flying = useRef(false)
  const goal = useRef({ target: new THREE.Vector3(), cam: new THREE.Vector3() })
  const fly = (target: THREE.Vector3, offset: THREE.Vector3) => {
    goal.current.target.copy(target)
    goal.current.cam.copy(target).add(offset)
    flying.current = true
  }
  useEffect(() => { fly(home, new THREE.Vector3(6, 34, 50)) }, [home.x, home.z]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (focus) fly(focus, new THREE.Vector3(10, 11, 17)) }, [focus])
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

export function City({ cluster, selected, onSelect, powerGrid, theme, onHover, states }: {
  cluster: ClusterState; selected: string | null; onSelect: (key: string | null) => void
  powerGrid: boolean; theme: Theme; onHover: OnHover; states: ServiceState
}) {
  const all = Object.values(cluster.objects)
  const deployments = all.filter((o) => o.kind === 'Deployment')
  const pods = all.filter((o) => o.kind === 'Pod')
  const nodes = all.filter((o) => o.kind === 'Node').sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const nodeColors = Object.fromEntries(nodes.map((n, i) => [n.metadata.name, NODE_COLORS[i % NODE_COLORS.length]]))
  const layoutKey = deployments.map(keyOf).sort().join(',') + '|' + nodes.map((n) => n.metadata.name).join(',')
  const layout = useMemo(() => layoutCity(
    deployments.map((d) => ({ namespace: d.metadata.namespace!, name: d.metadata.name })), nodes.map((n) => n.metadata.name)),
    [layoutKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const edges = cluster.edges.filter((e) => layout.lots[e.from] && layout.lots[e.to])
  useEffect(() => {
    if (import.meta.env.DEV) checkRoutes(layout, edges.map((e) => routeBetween(layout, e.from, e.to)))
  }, [layout, edges.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const focus = selected && layout.lots[selected] ? layout.lots[selected].center : null
  const podsOn = (node: string) => pods.filter((p) => p.spec.nodeName === node && !p.metadata.deletionTimestamp).length

  return (
    <Canvas shadows camera={{ position: [6, 40, 70], fov: 45 }} onPointerMissed={() => onSelect(null)}>
      <color attach="background" args={[theme.sky]} />
      <fog attach="fog" args={[theme.sky, ...theme.fog]} />
      <ambientLight intensity={theme.ambient} />
      <hemisphereLight args={[theme.sky, theme.ground, theme.ambient * 0.5]} />
      <directionalLight position={[30, 45, 25]} intensity={theme.sun} color={theme.sunColor} castShadow
        shadow-mapSize={[2048, 2048]} shadow-camera-left={-70} shadow-camera-right={70} shadow-camera-top={70} shadow-camera-bottom={-70} shadow-camera-far={200} />
      <Ground layout={layout} theme={theme} />
      <Scenery layout={layout} theme={theme} />
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
        <Traffic key={`${e.from}->${e.to}`} edge={e} layout={layout} theme={theme} onHover={onHover}
          accent={landmarkFor(nameOf(e.from)).accent} />
      ))}
      <OrbitControls makeDefault maxPolarAngle={Math.PI / 2.15} minDistance={8} maxDistance={140} />
      <CameraRig focus={focus} home={layout.focus} />
    </Canvas>
  )
}
