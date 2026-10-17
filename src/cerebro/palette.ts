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

const EDGE_TOKENS: Record<EdgeKind, string> = {
  link: '--elev-strong',
  'same-issue': '--danger',
  'same-entry': '--estimate',
  similar: '--blue',
}

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

export function readPalette(): Palette {
  const style = getComputedStyle(document.documentElement)
  const background = token(style, '--bg', '#32302f')
  const kinds = Object.fromEntries(
    Object.entries(KIND_TOKENS).map(([kind, name]) => [kind, token(style, name, '#a89984')]),
  ) as Record<NodeKind, string>
  const edges = Object.fromEntries(
    Object.entries(EDGE_TOKENS).map(([kind, name]) => [kind, mix(token(style, name, '#665c54'), background, 0.45)]),
  ) as Record<EdgeKind, string>
  return {
    kinds,
    edges,
    background,
    label: token(style, '--fg', '#ebdbb2'),
    faded: mix(token(style, '--elev', '#504945'), background, 0.25),
    fadedEdge: mix(token(style, '--line', '#45403d'), background, 0.4),
    strongEdge: token(style, '--fg-mute', '#a89984'),
  }
}
