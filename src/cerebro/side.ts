import type { Problem } from '../bita.ts'
import { element, icon } from '../dom.ts'
import type { BrainDetail, BrainNeighbor } from './api.ts'
import { KIND_LABELS, type Palette } from './palette.ts'

export interface SideHandlers {
  onOpen: () => void
  onNeighbor: (neighbor: BrainNeighbor) => void
}

const DATE = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' })
const EXCERPT_LENGTH = 280

export function day(value: string | null): string | null {
  if (value === null) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : DATE.format(parsed)
}

export function detailMeta(detail: BrainDetail): string {
  const updated = day(detail.updatedAt)
  return [
    detail.project === '' ? null : detail.project,
    updated === null ? null : `Actualizada ${updated}`,
    detail.source === null ? null : detail.sourceRef === null ? detail.source : `${detail.source} · ${detail.sourceRef}`,
  ]
    .filter((fact): fact is string => fact !== null)
    .join(' · ')
}

export function excerpt(body: string, length = EXCERPT_LENGTH): string {
  const plain = body
    .replace(/^(?:```|~~~)[^\n]*\n[\s\S]*?(?:\n(?:```|~~~)|$)/gm, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_match, target: string, label?: string) => label ?? target)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/[*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= length) return plain
  const cut = plain.slice(0, length)
  const space = cut.lastIndexOf(' ')
  return `${(space > length * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`
}

export function kindDot(color: string): HTMLElement {
  const dot = element('span', 'brain-dot')
  dot.style.setProperty('--dot', color)
  return dot
}

export function kindTag(detail: { kind: BrainDetail['kind'] }, palette: Palette): HTMLElement {
  const tag = element('span', 'brain-kind', KIND_LABELS[detail.kind])
  tag.style.setProperty('--dot', palette.kinds[detail.kind])
  return tag
}

export function sideEmpty(side: HTMLElement): void {
  side.replaceChildren(element('p', 'brain-side-note', 'Elige una estrella para leer su nota.'))
}

export function sideLoading(side: HTMLElement): void {
  side.replaceChildren(element('p', 'brain-side-note', 'Cargando…'))
}

export function sideProblem(side: HTMLElement, problem: Problem): void {
  const box = element('div', 'brain-side-note')
  box.append(element('p', 'brain-side-error', problem.message))
  if (problem.hint !== null) box.append(element('code', 'brain-hint', problem.hint))
  side.replaceChildren(box)
}

export function neighborButton(neighbor: BrainNeighbor, palette: Palette, onPick: () => void): HTMLButtonElement {
  const button = element('button', 'brain-neighbor') as HTMLButtonElement
  button.type = 'button'
  button.append(kindDot(palette.kinds[neighbor.kind]), element('span', 'brain-neighbor-title', neighbor.title))
  button.addEventListener('click', onPick)
  return button
}

export function sideDetail(side: HTMLElement, detail: BrainDetail, palette: Palette, handlers: SideHandlers): void {
  const parts: HTMLElement[] = [kindTag(detail, palette), element('h2', 'brain-side-title', detail.title)]
  const meta = detailMeta(detail)
  if (meta !== '') parts.push(element('p', 'brain-side-meta', meta))

  const text = excerpt(detail.body)
  parts.push(element('p', 'brain-side-excerpt', text === '' ? 'Esta nota no tiene contenido.' : text))

  const open = element('button', 'brain-open') as HTMLButtonElement
  open.type = 'button'
  open.append(icon('expand', 12), element('span', '', 'Abrir la nota'), element('kbd', 'brain-kbd', 'espacio'))
  open.addEventListener('click', handlers.onOpen)
  parts.push(open)

  parts.push(element('h3', 'brain-side-heading', `Conexiones · ${detail.neighbors.length}`))
  if (detail.neighbors.length === 0) {
    parts.push(element('p', 'brain-side-quiet', 'Sin conexiones.'))
  } else {
    const list = element('ul', 'brain-neighbors')
    for (const neighbor of detail.neighbors) {
      const item = element('li')
      item.append(neighborButton(neighbor, palette, () => handlers.onNeighbor(neighbor)))
      list.append(item)
    }
    parts.push(list)
  }

  side.replaceChildren(...parts)
}
