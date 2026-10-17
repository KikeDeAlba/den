import type { EdgeKind, NodeKind } from './api.ts'

export const KIND_LABELS: Record<NodeKind, string> = {
  rule: 'Regla',
  fact: 'Hecho',
  decision: 'Decisión',
  doc: 'Documento',
  entry: 'Entrada',
  issue: 'Ticket',
  meeting: 'Reunión',
  memory: 'Memoria',
}

export const EDGE_LABELS: Record<EdgeKind, string> = {
  link: 'Enlaces',
  'same-issue': 'Mismo ticket',
  'same-entry': 'Misma entrada',
  similar: 'Parecidos',
}

const KIND_TOKENS: Record<NodeKind, string> = {
  rule: '--running',
  fact: '--blue',
  decision: '--purple',
  doc: '--aqua',
  entry: '--estimate',
  issue: '--danger',
  meeting: '--ok',
  memory: '--fg-dim',
}

export const SKY = {
  top: '#0b1020',
  deep: '#03050c',
  star: '#f4f7ff',
  label: '#cfd8ff',
  backdrop: 'rgba(8, 12, 28, 0.88)',
  backdropShadow: 'rgba(110, 150, 255, 0.35)',
  faded: 'rgba(130, 145, 190, 0.15)',
  fadedEdge: 'rgba(150, 170, 220, 0.06)',
  strongEdge: 'rgba(206, 230, 255, 0.92)',
  edges: {
    link: 'rgba(186, 214, 255, 0.35)',
    'same-issue': 'rgba(255, 196, 214, 0.32)',
    'same-entry': 'rgba(255, 226, 184, 0.32)',
    similar: 'rgba(186, 214, 255, 0.16)',
  } satisfies Record<EdgeKind, string>,
} as const

export interface Palette {
  kinds: Record<NodeKind, string>
  edges: Record<EdgeKind, string>
  background: string
  label: string
  faded: string
  fadedEdge: string
  strongEdge: string
}

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  const value = style.getPropertyValue(name).trim()
  return value === '' ? fallback : value
}

function channels(color: string): [number, number, number] | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
  if (hex === null) return null
  const digits = hex[1] ?? ''
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join('') : digits
  return [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16)) as [number, number, number]
}

export function mix(color: string, base: string, amount: number): string {
  const from = channels(color)
  const to = channels(base)
  if (from === null || to === null) return color
  const blended = from.map((value, index) => Math.round(value * (1 - amount) + (to[index] ?? value) * amount))
  return `#${blended.map((value) => value.toString(16).padStart(2, '0')).join('')}`
}

export function fade(color: string, factor: number): string {
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color)
  if (rgba !== null) {
    const alpha = rgba[4] === undefined ? 1 : Number(rgba[4])
    return `rgba(${rgba[1]}, ${rgba[2]}, ${rgba[3]}, ${alpha * factor})`
  }
  const hex = channels(color)
  if (hex === null) return color
  return `rgba(${hex[0]}, ${hex[1]}, ${hex[2]}, ${factor})`
}

export function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement)
  const kinds = Object.fromEntries(
    Object.entries(KIND_TOKENS).map(([kind, name]) => [kind, mix(token(style, name, '#a89984'), '#ffffff', 0.35)]),
  ) as Record<NodeKind, string>
  return {
    kinds,
    edges: { ...SKY.edges },
    background: SKY.deep,
    label: SKY.label,
    faded: SKY.faded,
    fadedEdge: SKY.fadedEdge,
    strongEdge: SKY.strongEdge,
  }
}
