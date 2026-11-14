import { useEffect, useState } from 'react'

export interface Theme {
  mode: 'night' | 'day'
  sky: string
  fog: [number, number]
  ambient: number
  sun: number
  sunColor: string
  ground: string
  district: string   // District pads
  groundText: string // District names painted on the ground
  street: string     // Road surface
  kerb: string       // pavement either side of a Road
  laneMark: string   // dashed centre line and lane arrows
  roadGlow: string   // centre line of a healthy Road
  marking: string    // outline of an empty Plot
  plot: string
  headlights: boolean
  labelBg: string
  labelFg: string
}

export const THEMES: Record<Theme['mode'], Theme> = {
  night: {
    mode: 'night', sky: '#0a1128', fog: [110, 260], ambient: 1.0, sun: 1.3, sunColor: '#b4c2ff',
    ground: '#0e1730', district: '#1f2c52', groundText: '#7f93bd', street: '#323d5c', kerb: '#46527a', laneMark: '#e2e8f0', roadGlow: '#38bdf8',
    marking: '#facc15', plot: '#2a3760', headlights: true, labelBg: 'rgba(2,6,23,0.88)', labelFg: '#e2e8f0',
  },
  day: {
    mode: 'day', sky: '#cfe9ff', fog: [130, 300], ambient: 0.95, sun: 1.8, sunColor: '#fff7e6',
    ground: '#a9d694', district: '#ece7dd', groundText: '#8a8577', street: '#4b5563', kerb: '#c9c3b8', laneMark: '#f8fafc', roadGlow: '#38bdf8',
    marking: '#f59e0b', plot: '#d6d0c4', headlights: false, labelBg: 'rgba(255,255,255,0.94)', labelFg: '#0f172a',
  },
}

export function useThemeMode() {
  const [mode, setMode] = useState<Theme['mode']>(() => {
    try { return localStorage.getItem('kubeverse.theme') === 'day' ? 'day' : 'night' } catch { return 'night' }
  })
  useEffect(() => {
    try { localStorage.setItem('kubeverse.theme', mode) } catch { /* storage blocked: per-viewer nicety only */ }
  }, [mode])
  return [mode, setMode] as const
}
