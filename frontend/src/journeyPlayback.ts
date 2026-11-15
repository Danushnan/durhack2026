import type { Vector3 } from 'three'
export const JOURNEY_SPEEDS = [0.25, 0.5, 0.75, 1] as const
export type JourneySpeed = typeof JOURNEY_SPEEDS[number]
export type JourneyAnchor = { position: Vector3; active: boolean }
