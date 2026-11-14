import { useEffect, useState } from 'react'

export interface Theme {
  mode: 'night' | 'day'
  sky: string
  fog: [number, number]
  ambient: number
  sun: number
  sunColor: string
  ground: string
  district: string
  lot: string
  street: string
  marking: string
  wall: string
  glow: number       // emissive strength of windows/signs
  headlights: boolean
  labelBg: string
  labelFg: string
}

export const THEMES: Record<Theme['mode'], Theme> = {
  night: {
    mode: 'night', sky: '#070b1f', fog: [90, 230], ambient: 0.7, sun: 1.1, sunColor: '#a5b4fc',
    ground: '#0b1226', district: '#16213f', lot: '#121a2e', street: '#232c45', marking: '#facc15', wall: '#64748b',
    glow: 1.3, headlights: true, labelBg: 'rgba(2,6,23,0.85)', labelFg: '#e2e8f0',
  },
  day: {
    mode: 'day', sky: '#bfe3ff', fog: [110, 280], ambient: 0.9, sun: 1.8, sunColor: '#fff7e6',
    ground: '#9ccf86', district: '#d9d4cc', lot: '#e7e2d9', street: '#4b5563', marking: '#f8fafc', wall: '#f1f5f9',
    glow: 0.35, headlights: false, labelBg: 'rgba(255,255,255,0.92)', labelFg: '#0f172a',
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
