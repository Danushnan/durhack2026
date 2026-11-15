import { useEffect, useMemo, useRef, type RefObject } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { Path } from './layout'
import type { StreetRoute } from './streetNetwork'
import type { JourneyStep } from './Journey'
import type { JourneyAnchor, JourneySpeed } from './journeyPlayback'

/** The one educational guide uses the city's existing lane and roundabout paths. */
export function JourneyGuide({step, road, positions, anchor, speed}: {
  step: JourneyStep; road?: StreetRoute; positions: THREE.Vector3[]; anchor: RefObject<JourneyAnchor>; speed: JourneySpeed
}) {
  const car = useRef<THREE.Group>(null)
  const elapsed = useRef(0)
  const visible = positions.length > 0 && ['observed', 'failed', 'succeeded', 'skipped'].includes(step.state)
  const path = useMemo(() => road ? new Path(road.outbound) : null, [road])
  const line = useMemo(() => {
    if (!road) return null
    return new THREE.Line(new THREE.BufferGeometry().setFromPoints(road.outbound.map(p => p.clone().setY(0.35))),
      new THREE.LineBasicMaterial({color: '#ffd166', depthTest: false}))
  }, [road])
  useEffect(() => () => { line?.geometry.dispose(); line?.material.dispose() }, [line])
  useEffect(() => () => { anchor.current.active = false }, [anchor])
  useFrame((_, delta) => {
    anchor.current.active = visible && !!car.current
    if (!car.current || !visible) return
    elapsed.current = Math.min(3, elapsed.current + Math.min(delta, 0.1) * speed)
    if (path) {
      car.current.rotation.y = path.at(path.length * elapsed.current / 3, car.current.position)
      car.current.position.y = 0.45
    } else car.current.position.copy(positions[0]).setY(8)
    anchor.current.position.copy(car.current.position).y += 1.25
  })
  if (!visible) return null
  return <group>
    {line && <primitive object={line} />}
    {positions.map((position, i) => <mesh key={i} position={[position.x, 0.3, position.z]} rotation-x={-Math.PI / 2}>
      <ringGeometry args={[8, 8.6, 48]} /><meshBasicMaterial color="#ffd166" transparent opacity={0.85} depthWrite={false} />
    </mesh>)}
    <group ref={car}>
      <mesh position-y={0.55} renderOrder={10}><boxGeometry args={[2.5, 0.65, 1.3]} /><meshStandardMaterial color="#ffd166" emissive="#d6a53b" emissiveIntensity={0.8} depthTest={false} /></mesh>
      <mesh position={[-0.2, 1.1, 0]} renderOrder={11}><boxGeometry args={[1.2, 0.5, 1.1]} /><meshBasicMaterial color="#fff3bd" depthTest={false} /></mesh>
      {[-0.8, 0.8].flatMap(x => [-0.7, 0.7].map(z => <mesh key={`${x}:${z}`} position={[x, 0.2, z]} rotation-x={Math.PI / 2} renderOrder={12}>
        <cylinderGeometry args={[0.3, 0.3, 0.22, 12]} /><meshBasicMaterial color="#263242" depthTest={false} />
      </mesh>))}
    </group>
  </group>
}

type Controls = {target: THREE.Vector3; update(): void; addEventListener(type: 'start', listener: () => void): void; removeEventListener(type: 'start', listener: () => void): void}

/** Follow the guide beside the explanation panel without per-frame React updates. */
export function JourneyFollowCamera({anchor, active, onManualCamera}: {anchor: RefObject<JourneyAnchor>; active: boolean; onManualCamera: () => void}) {
  const camera = useThree(s => s.camera)
  const controls = useThree(s => s.controls) as unknown as Controls | null
  const size = useThree(s => s.size)
  const cameraDistance = useRef(300)
  const direction = useRef(new THREE.Vector3(0, 0.62, 0.78))
  const scratch = useMemo(() => ({right: new THREE.Vector3(), up: new THREE.Vector3(), target: new THREE.Vector3(), position: new THREE.Vector3()}), [])
  useEffect(() => {
    if (active && controls) {
      cameraDistance.current = camera.position.distanceTo(controls.target)
      direction.current.copy(camera.position).sub(controls.target).normalize()
    }
  }, [active, camera, controls])
  useEffect(() => {
    if (!active || !controls) return
    controls.addEventListener('start', onManualCamera)
    return () => controls.removeEventListener('start', onManualCamera)
  }, [active, controls, onManualCamera])
  useFrame((_, delta) => {
    if (!active || !anchor.current.active || !controls) return
    const orthographic = (camera as THREE.OrthographicCamera).isOrthographicCamera
    const zoom = Math.min(22, size.width / (size.width <= 720 ? 40 : 60), size.height / 60)
    const distance = size.width <= 720 ? 45 : 55
    const scale = orthographic ? zoom : size.height / (2 * Math.tan(THREE.MathUtils.degToRad((camera as THREE.PerspectiveCamera).fov / 2)) * distance)
    const guideY = size.width <= 720 ? size.height - 72 : size.height * 0.56
    scratch.right.set(1, 0, 0).applyQuaternion(camera.quaternion)
    scratch.up.set(0, 1, 0).applyQuaternion(camera.quaternion)
    scratch.target.copy(anchor.current.position)
      .addScaledVector(scratch.up, (guideY - size.height / 2) / scale)
      .addScaledVector(scratch.right, size.width <= 720 ? 0 : -150 / scale)
    const smooth = 1 - Math.exp(-Math.min(delta, 0.1) * 4)
    controls.target.lerp(scratch.target, smooth)
    const offset = orthographic ? 300 : distance
    cameraDistance.current += (offset - cameraDistance.current) * smooth
    scratch.position.copy(controls.target).addScaledVector(direction.current, cameraDistance.current)
    camera.position.copy(scratch.position)
    if (orthographic) {
      const ortho = camera as THREE.OrthographicCamera
      ortho.zoom += (zoom - ortho.zoom) * smooth
      ortho.updateProjectionMatrix()
    }
    controls.update()
    camera.updateMatrixWorld()
  })
  return null
}
