import { Canvas, type ThreeEvent, useFrame, useThree } from '@react-three/fiber'
import { Edges, OrbitControls } from '@react-three/drei'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import {
  type ClusterState, type Edge, type K8sObject, deploymentHealth, describeDeployment, describePod, HEALTH_COLOR,
  keyOf, NODE_COLORS, podStatus, STATUS_COLOR,
} from './k8s'
import { Landmark, type LandmarkInfo, landmarkFor } from './landmarks'
import { type CityLayout, checkRoutes, DRIVEWAY_X, laneOffset, layoutCity, LOT, Path, routeBetween, STREET_W } from './layout'
import type { Theme } from './theme'

export interface HoverInfo { title: string; lines: string[]; x: number; y: number }
type OnHover = (h: HoverInfo | null) => void

const UNIT = 0.9
const UNIT_GAP = 1.25
const UNIT_COLS = 6
const CAR_SPEED = 6 // world units per second
const PARK_SECONDS = 1.2

// ---------- text labels as sprites (no DOM, so they never fight the camera or React roots) ----------

function Label({ text, position, fg, bg, border, scale = 1 }: {
  text: string; position: [number, number, number]; fg: string; bg: string; border: string; scale?: number
}) {
  const tex = useMemo(() => {
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')!
    const font = '600 44px ui-monospace, Menlo, monospace'
    ctx.font = font
    const w = Math.ceil(ctx.measureText(text).width) + 48
    c.width = w; c.height = 76
    ctx.font = font
    ctx.fillStyle = bg
    ctx.strokeStyle = border
    ctx.lineWidth = 6
    ctx.beginPath(); ctx.roundRect(3, 3, w - 6, 70, 14); ctx.fill(); ctx.stroke()
    ctx.fillStyle = fg
    ctx.textBaseline = 'middle'
    ctx.fillText(text, 24, 40)
    const t = new THREE.CanvasTexture(c)
    t.colorSpace = THREE.SRGBColorSpace
    return t
  }, [text, fg, bg, border])
  useEffect(() => () => tex.dispose(), [tex])
  const aspect = tex.image.width / tex.image.height
  return (
    <sprite position={position} scale={[1.3 * aspect * scale, 1.3 * scale, 1]} renderOrder={10}>
      <spriteMaterial map={tex} depthTest={false} transparent />
    </sprite>
  )
}

// ---------- ground, streets, districts ----------

function Ground({ layout, theme }: { layout: CityLayout; theme: Theme }) {
  const { x0, x1, z0, z1 } = layout.extent
  const w = x1 - x0 + 40, d = z1 - z0 + 40
  const len = (a: number, b: number) => b - a + STREET_W
  return (
    <group>
      <mesh rotation-x={-Math.PI / 2} position={[0, -0.02, 0]} receiveShadow>
        <planeGeometry args={[w * 3, d * 3]} />
        <meshStandardMaterial color={theme.ground} />
      </mesh>
      {layout.districts.map((dist) => (
        <group key={dist.name}>
          <mesh rotation-x={-Math.PI / 2} position={[(dist.x0 + dist.x1) / 2, 0, (dist.z0 + dist.z1) / 2]}>
            <planeGeometry args={[dist.x1 - dist.x0, dist.z1 - dist.z0]} />
            <meshStandardMaterial color={theme.district} />
          </mesh>
          {/* Street sign on the district's front-left corner */}
          <mesh position={[dist.x0 + 2, 1.2, dist.z1 + 2]}><cylinderGeometry args={[0.08, 0.08, 2.4, 8]} /><meshStandardMaterial color="#64748b" /></mesh>
          <Label text={`${dist.name.toUpperCase()} DISTRICT`} position={[dist.x0 + 2, 2.8, dist.z1 + 2]}
            fg="#ffffff" bg="#15803d" border="#f8fafc" scale={1.3} />
        </group>
      ))}
      {layout.streetsX.map((x) => (
        <group key={`x${x}`}>
          <mesh rotation-x={-Math.PI / 2} position={[x, 0.01, 0]}>
            <planeGeometry args={[STREET_W, len(z0, z1)]} /><meshStandardMaterial color={theme.street} />
          </mesh>
          <mesh rotation-x={-Math.PI / 2} position={[x, 0.02, 0]}>
            <planeGeometry args={[0.08, len(z0, z1)]} /><meshBasicMaterial color={theme.marking} />
          </mesh>
        </group>
      ))}
      {layout.streetsZ.map((z) => (
        <group key={`z${z}`}>
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.011, z]}>
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
      onPointerOver={(e) => { e.stopPropagation(); onHover({ title: `Unit ${pod.metadata.name}`, lines: [describePod(pod), `Pod · ${status}`, `Node: ${pod.spec.nodeName ?? 'none yet'}`], x: e.nativeEvent.clientX, y: e.nativeEvent.clientY }) }}
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

function Building({ dep, info, pods, pos, selected, onSelect, powerGrid, nodeColors, theme, onHover }: {
  dep: K8sObject; info: LandmarkInfo; pods: K8sObject[]; pos: THREE.Vector3; selected: boolean; onSelect: () => void
  powerGrid: boolean; nodeColors: Record<string, string>; theme: Theme; onHover: OnHover
}) {
  const health = deploymentHealth(dep)
  const desired: number = dep.spec.replicas
  const sorted = [...pods].sort((a, b) => (a.metadata.creationTimestamp ?? '').localeCompare(b.metadata.creationTimestamp ?? ''))
  const plots = Math.max(0, desired - sorted.filter((p) => !p.metadata.deletionTimestamp).length)
  const glowRef = useRef(HEALTH_COLOR[health])
  glowRef.current = HEALTH_COLOR[health]
  const hover = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    onHover({ title: `${info.emoji} ${info.title}: ${dep.metadata.name}`, lines: [describeDeployment(dep), 'Click to inspect'], x: e.nativeEvent.clientX, y: e.nativeEvent.clientY })
  }
  return (
    <group position={pos}>
      {/* Lot */}
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.005, 0]}>
        <planeGeometry args={[LOT - STREET_W, LOT - STREET_W]} />
        <meshStandardMaterial color={selected ? info.accent : theme.district} transparent opacity={selected ? 0.35 : 1} />
      </mesh>
      {/* Driveway to the street */}
      <mesh rotation-x={-Math.PI / 2} position={[DRIVEWAY_X, 0.012, LOT / 2 - STREET_W]}>
        <planeGeometry args={[1.8, STREET_W]} /><meshStandardMaterial color={theme.street} />
      </mesh>
      <group position={[0, 0, -2]}>
        <Landmark info={info} glow={HEALTH_COLOR[health]} theme={theme} />
        {/* One invisible hit-box for hover/click instead of handlers on every part */}
        <mesh position={[0, info.height / 2, 0]} visible={false}
          onClick={(e) => { e.stopPropagation(); onSelect() }}
          onPointerOver={hover} onPointerMove={hover} onPointerOut={() => onHover(null)}>
          <boxGeometry args={[7.5, info.height, 5.5]} />
        </mesh>
      </group>
      {sorted.map((p, i) => (
        <Unit key={p.metadata.uid} pod={p} index={i} powerGrid={powerGrid} nodeColor={nodeColors[p.spec.nodeName]} onHover={onHover} />
      ))}
      {Array.from({ length: plots }, (_, i) => <Plot key={`plot${i}`} index={sorted.length + i} color={theme.marking} />)}
      <Label text={`${info.emoji} ${dep.metadata.name}  ${dep.status.readyReplicas}/${desired}`}
        position={[0, info.height + 0.6, -2]} fg={theme.labelFg} bg={theme.labelBg}
        border={selected ? info.accent : HEALTH_COLOR[health]} />
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
  const [src, dst] = [edge.from.split('/')[1], edge.to.split('/')[1]]
  return (
    <group>
      {Array.from({ length: count }, (_, i) => (
        <group key={i} ref={(g) => { refs.current[i] = g }}
          onPointerOver={(e) => { e.stopPropagation(); onHover({ title: `🚗 Request ${src} → ${dst}`, lines: [edge.healthy ? 'Delivered successfully' : `Failed: ${dst} has no working Units, turning back`, `${edge.rps} requests/second on this route`], x: e.nativeEvent.clientX, y: e.nativeEvent.clientY }) }}
          onPointerOut={() => onHover(null)}>
          <Car color={color} theme={theme} hazards={!edge.healthy} />
        </group>
      ))}
    </group>
  )
}

// ---------- camera fly-to ----------

interface Controls extends THREE.EventDispatcher<{ start: object }> { target: THREE.Vector3; update(): void }

function CameraRig({ focus }: { focus: THREE.Vector3 | null }) {
  const camera = useThree((s) => s.camera)
  const controls = useThree((s) => s.controls) as unknown as Controls | null
  const flying = useRef(false)
  const goal = useRef({ target: new THREE.Vector3(), cam: new THREE.Vector3() })
  useEffect(() => {
    if (!focus) return
    goal.current.target.copy(focus)
    goal.current.cam.copy(focus).add(new THREE.Vector3(9, 10, 14))
    flying.current = true
  }, [focus])
  useEffect(() => {
    if (!controls) return
    const stop = () => { flying.current = false } // the user grabbed the camera
    controls.addEventListener('start', stop)
    return () => controls.removeEventListener('start', stop)
  }, [controls])
  useFrame((_, dt) => {
    if (!flying.current || !controls) return
    const k = Math.min(1, dt * 3)
    controls.target.lerp(goal.current.target, k)
    camera.position.lerp(goal.current.cam, k)
    controls.update()
    if (camera.position.distanceTo(goal.current.cam) < 0.05) flying.current = false
  })
  return null
}

// ---------- the City ----------

export function City({ cluster, selected, onSelect, powerGrid, theme, onHover }: {
  cluster: ClusterState; selected: string | null; onSelect: (key: string | null) => void
  powerGrid: boolean; theme: Theme; onHover: OnHover
}) {
  const all = Object.values(cluster.objects)
  const deployments = all.filter((o) => o.kind === 'Deployment')
  const pods = all.filter((o) => o.kind === 'Pod')
  const nodes = all.filter((o) => o.kind === 'Node').sort((a, b) => a.metadata.name.localeCompare(b.metadata.name))
  const nodeColors = Object.fromEntries(nodes.map((n, i) => [n.metadata.name, NODE_COLORS[i % NODE_COLORS.length]]))
  const layoutKey = deployments.map(keyOf).sort().join(',')
  const layout = useMemo(() => layoutCity(deployments.map((d) => ({ namespace: d.metadata.namespace!, name: d.metadata.name }))),
    [layoutKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const edges = cluster.edges.filter((e) => layout.lots[e.from] && layout.lots[e.to])
  useEffect(() => {
    if (import.meta.env.DEV) checkRoutes(layout, edges.map((e) => routeBetween(layout, e.from, e.to)))
  }, [layout, edges.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const focus = selected && layout.lots[selected] ? layout.lots[selected].center : null

  return (
    <Canvas shadows camera={{ position: [4, 17, 30], fov: 45 }} onPointerMissed={() => onSelect(null)}>
      <color attach="background" args={[theme.sky]} />
      <fog attach="fog" args={[theme.sky, ...theme.fog]} />
      <ambientLight intensity={theme.ambient} />
      <hemisphereLight args={[theme.sky, theme.ground, theme.ambient * 0.5]} />
      <directionalLight position={[20, 30, 15]} intensity={theme.sun} color={theme.sunColor} castShadow
        shadow-mapSize={[2048, 2048]} shadow-camera-left={-40} shadow-camera-right={40} shadow-camera-top={40} shadow-camera-bottom={-40} />
      <Ground layout={layout} theme={theme} />
      {deployments.map((dep) => {
        const key = keyOf(dep)
        const lot = layout.lots[key]
        if (!lot) return null
        return (
          <Building key={dep.metadata.uid} dep={dep} info={landmarkFor(dep.metadata.name)} pos={lot.center}
            selected={selected === key} onSelect={() => onSelect(key)} powerGrid={powerGrid} nodeColors={nodeColors}
            theme={theme} onHover={onHover}
            pods={pods.filter((p) => p.metadata.namespace === dep.metadata.namespace && p.metadata.labels?.app === dep.metadata.name)} />
        )
      })}
      {edges.map((e) => (
        <Traffic key={`${e.from}->${e.to}`} edge={e} layout={layout} theme={theme} onHover={onHover}
          accent={landmarkFor(e.from.split('/')[1]).accent} />
      ))}
      <OrbitControls makeDefault maxPolarAngle={Math.PI / 2.15} minDistance={8} maxDistance={90} />
      <CameraRig focus={focus} />
    </Canvas>
  )
}
