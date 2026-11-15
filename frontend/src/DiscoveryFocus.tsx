import {useEffect,useMemo} from 'react'
import * as THREE from 'three'
import type {StreetRoute} from './streetNetwork'

/** Use the actual directed lane, including shared roads and existing roundabouts. */
export function DiscoveryFocus({road,positions,color}: {road:StreetRoute;positions:THREE.Vector3[];color:string}) {
  const line=useMemo(()=>new THREE.Line(new THREE.BufferGeometry().setFromPoints(road.outbound.map(p=>p.clone().setY(.22))),
    new THREE.LineBasicMaterial({color,depthTest:false,transparent:true,opacity:.95})),[road,color])
  useEffect(()=>()=>{line.geometry.dispose();line.material.dispose()},[line])
  return <group>
    <primitive object={line} />
    {positions.map((position,i)=><mesh key={i} position={[position.x,.28,position.z]} rotation-x={-Math.PI/2}>
      <ringGeometry args={[8.8,9.25,48]}/><meshBasicMaterial color={color} transparent opacity={.8} depthWrite={false}/>
    </mesh>)}
  </group>
}
