import * as THREE from 'three'

export interface TextLine { text: string; px: number; color: string; weight?: number }

/** Draw lines of text on a rounded panel; returns the texture and its aspect ratio. */
export function textTexture(lines: TextLine[], opts: { bg: string; border?: string; pad?: number; radius?: number }) {
  const pad = opts.pad ?? 26
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')!
  const font = (l: TextLine) => `${l.weight ?? 700} ${l.px}px ui-sans-serif, -apple-system, 'Segoe UI', sans-serif`
  const widths = lines.map((l) => { ctx.font = font(l); return ctx.measureText(l.text).width })
  c.width = Math.ceil(Math.max(...widths) + pad * 2)
  c.height = Math.ceil(lines.reduce((h, l) => h + l.px * 1.25, 0) + pad * 1.4)
  ctx.fillStyle = opts.bg
  ctx.beginPath(); ctx.roundRect(4, 4, c.width - 8, c.height - 8, opts.radius ?? 16); ctx.fill()
  if (opts.border) { ctx.strokeStyle = opts.border; ctx.lineWidth = 8; ctx.stroke() }
  let y = pad * 0.7
  lines.forEach((l, i) => {
    ctx.font = font(l)
    ctx.fillStyle = l.color
    ctx.textBaseline = 'top'
    ctx.fillText(l.text, (c.width - widths[i]) / 2, y)
    y += l.px * 1.25
  })
  const texture = new THREE.CanvasTexture(c)
  texture.colorSpace = THREE.SRGBColorSpace
  texture.anisotropy = 4
  return { texture, aspect: c.width / c.height, height: c.height }
}
