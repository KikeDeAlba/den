import type { Problem } from '../bita.ts'
import { element, iconButton } from '../dom.ts'
import { renderMarkdown } from '../notes/markdown.ts'
import type { BrainDetail, BrainNeighbor } from './api.ts'
import { EDGE_LABELS, KIND_LABELS, type Palette } from './palette.ts'

export interface SideHandlers {
  onClose: () => void
  onNeighbor: (neighbor: BrainNeighbor) => void
  onLink: (url: string) => void
}

const DATE = new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium' })

function day(value: string | null): string | null {
  if (value === null) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : DATE.format(parsed)
}

export function kindDot(color: string): HTMLElement {
  const dot = element('span', 'brain-dot')
  dot.style.setProperty('--dot', color)
  return dot
}

function head(title: string, handlers: SideHandlers): HTMLElement {
  const bar = element('div', 'brain-side-bar')
  bar.append(element('span', 'brain-side-label', title))
  const close = iconButton('close', 'brain-icon-button', 'Cerrar el detalle')
  close.addEventListener('click', handlers.onClose)
  bar.append(close)
  return bar
}

export function sideLoading(side: HTMLElement, handlers: SideHandlers): void {
  side.replaceChildren(head('Nodo', handlers), element('p', 'brain-side-note', 'Cargando…'))
}

export function sideProblem(side: HTMLElement, problem: Problem, handlers: SideHandlers): void {
  const box = element('div', 'brain-side-note')
  box.append(element('p', 'brain-side-error', problem.message))
  if (problem.hint !== null) box.append(element('code', 'brain-hint', problem.hint))
  side.replaceChildren(head('Nodo', handlers), box)
}

export function sideDetail(side: HTMLElement, detail: BrainDetail, palette: Palette, handlers: SideHandlers): void {
  const scroll = element('div', 'brain-side-scroll')

  const kind = element('div', 'brain-side-kind')
  kind.append(kindDot(palette.kinds[detail.kind]), element('span', '', KIND_LABELS[detail.kind]))
  if (detail.project !== '') kind.append(element('span', 'brain-side-project', detail.project))
  scroll.append(kind, element('h1', 'brain-side-title', detail.title))

  const facts = [
    day(detail.updatedAt) === null ? null : `Actualizado ${day(detail.updatedAt)}`,
    detail.source === null ? null : detail.sourceRef === null ? detail.source : `${detail.source} · ${detail.sourceRef}`,
  ].filter((fact): fact is string => fact !== null)
  if (facts.length > 0) scroll.append(element('p', 'brain-side-meta', facts.join(' · ')))

  const body = element('div', 'brain-side-body')
  if (detail.body.trim() === '') body.append(element('p', 'brain-side-note', 'Este nodo no tiene contenido.'))
  else body.append(renderMarkdown(detail.body, { onLink: handlers.onLink }))
  scroll.append(body)

  const links = element('section', 'brain-side-links')
  links.append(element('h2', 'brain-side-heading', `Conexiones · ${detail.neighbors.length}`))
  if (detail.neighbors.length === 0) {
    links.append(element('p', 'brain-side-note', 'Sin conexiones.'))
  } else {
    const list = element('ul', 'brain-neighbors')
    for (const neighbor of detail.neighbors) {
      const item = element('li')
      const button = element('button', 'brain-neighbor') as HTMLButtonElement
      button.type = 'button'
      button.append(
        kindDot(palette.kinds[neighbor.kind]),
        element('span', 'brain-neighbor-title', neighbor.title),
        element('span', 'brain-neighbor-edge', EDGE_LABELS[neighbor.edgeKind]),
      )
      button.addEventListener('click', () => handlers.onNeighbor(neighbor))
      item.append(button)
      list.append(item)
    }
    links.append(list)
  }
  scroll.append(links)

  side.replaceChildren(head('Nodo', handlers), scroll)
}
