import { describeProblem } from '../bita.ts'
import { element, icon } from '../dom.ts'
import { human } from '../format.ts'
import { GOAL_HOURS, hours, LONG_DAY_HOURS } from './model.ts'

export function markIcon(size = 15): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = '<circle cx="8" cy="9" r="5.4"/><path d="M8 6.3V9l1.8 1.1M6.2 1.9h3.6"/>'
  return svg
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = element('button', className, label) as HTMLButtonElement
  node.type = 'button'
  node.addEventListener('click', onClick)
  return node
}

export function primaryAction(label: string, onClick: () => void): HTMLButtonElement {
  const node = element('button', 'primary-button report-primary') as HTMLButtonElement
  node.type = 'button'
  node.append(icon('download', 13), element('span', undefined, label))
  node.addEventListener('click', onClick)
  return node
}

export function card(className: string, label: string, title?: string): HTMLElement {
  const section = element('section', `report-card ${className}`)
  section.setAttribute('aria-label', label)
  if (title !== undefined) section.append(element('h2', 'report-card-title', title))
  return section
}

export interface Kpi {
  label: string
  value: string
  note: string
  tone?: 'ok' | 'estimate'
}

export function kpis(items: Kpi[], minWidth: number): HTMLElement {
  const grid = element('section', 'report-kpis')
  grid.setAttribute('aria-label', 'Resumen')
  grid.style.setProperty('--kpi-min', `${minWidth}px`)
  for (const item of items) {
    const box = element('div', 'report-kpi')
    const value = element('span', 'report-kpi-value', item.value)
    if (item.tone !== undefined) value.classList.add(`report-kpi-value--${item.tone}`)
    box.append(element('span', 'report-kpi-label', item.label), value, element('span', 'report-kpi-note', item.note))
    grid.append(box)
  }
  return grid
}

export function segmented<T extends string>(
  label: string,
  options: { id: T; label: string }[],
  value: T,
  onChange: (id: T) => void,
  key: string,
): HTMLElement {
  const group = element('div', 'segmented report-segmented')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', label)
  for (const option of options) {
    const node = button(option.label, option.id === value ? 'segmented-on' : '', () => {
      if (option.id !== value) onChange(option.id)
    })
    node.setAttribute('aria-pressed', String(option.id === value))
    node.dataset['key'] = `${key}-${option.id}`
    group.append(node)
  }
  return group
}

export function pill(name: string, color: string, empty = false): HTMLElement {
  if (empty) return element('span', 'pill pill--empty', name)
  const node = element('span', 'pill')
  const dot = element('i', 'dot')
  dot.style.background = color
  node.append(dot, element('span', 'pill-name', name))
  return node
}

export function swatch(color: string, className = 'report-swatch'): HTMLElement {
  const node = element('span', className)
  node.style.background = color
  return node
}

export function loading(text = 'Preguntando al CLI…'): HTMLElement {
  const box = element('div', 'report-state')
  box.setAttribute('role', 'status')
  const spin = icon('spinner', 16)
  spin.classList.add('report-spinner')
  box.append(spin, element('p', 'report-state-title', text))
  return box
}

export function problemState(error: unknown, retry: () => void): HTMLElement {
  const problem = describeProblem(error)
  const box = element('div', 'report-state report-state--problem')
  box.setAttribute('role', 'alert')
  box.append(icon('warning', 16), element('p', 'report-state-title', problem.message))
  if (problem.hint !== null) box.append(element('code', 'report-state-hint', problem.hint))
  box.append(button('Reintentar', 'ghost-button', retry))
  return box
}

export function emptyState(title: string, note: string): HTMLElement {
  const box = element('div', 'report-state report-state--empty')
  box.append(icon('clock', 16), element('p', 'report-state-title', title), element('p', 'report-state-note', note))
  return box
}

export interface Column {
  key: string
  label: string
  tip: string
  seconds: number
  weekend?: boolean
  overlap?: number
}

export interface ColumnOptions {
  height: number
  color: string
  goal: boolean
  highlight: boolean
  values: 'hide' | 'blank' | 'dash'
  minWidth: number
  gap: number
  maxBar: number
}

export function columnChart(label: string, columns: Column[], options: ColumnOptions): HTMLElement {
  const scroll = element('div', 'report-chart-scroll')
  const plot = element('div', 'report-columns')
  plot.setAttribute('role', 'group')
  plot.setAttribute('aria-label', label)
  plot.style.height = `${options.height}px`
  plot.style.minWidth = `${options.minWidth}px`
  plot.style.gap = `${options.gap}px`
  const room = options.height - (options.values === 'hide' ? 6 : 20)
  const peak = Math.max(...columns.map((column) => column.seconds / 3600), options.goal ? GOAL_HOURS * 1.25 : 0.5)
  const scale = room / peak
  if (options.goal) {
    const line = element('div', 'report-goal')
    line.style.bottom = `${GOAL_HOURS * scale}px`
    line.setAttribute('aria-hidden', 'true')
    plot.append(line)
  }
  for (const column of columns) {
    const value = column.seconds / 3600
    const node = element('div', 'report-column')
    const overlap = column.overlap ?? 0
    const tip = `${column.tip} · ${hours(column.seconds)}${column.seconds > 0 ? ` (${human(column.seconds)})` : ''}${overlap > 0 ? ` · ${hours(overlap)} en paralelo` : ''}`
    node.title = tip
    node.setAttribute('aria-label', tip)
    node.setAttribute('role', 'img')
    if (options.values !== 'hide') {
      const text = value > 0 ? value.toFixed(1) : options.values === 'dash' ? '—' : ''
      node.append(element('span', 'report-column-value', text))
    }
    const bar = element('div', 'report-column-bar')
    bar.style.height = `${value > 0 ? Math.max(value * scale, 2) : 0}px`
    bar.style.maxWidth = `${options.maxBar}px`
    bar.style.background = options.highlight && value > LONG_DAY_HOURS ? 'var(--purple)' : options.color
    node.append(bar)
    plot.append(node)
  }
  const axis = element('div', 'report-axis')
  axis.style.minWidth = `${options.minWidth}px`
  axis.style.gap = `${options.gap}px`
  axis.setAttribute('aria-hidden', 'true')
  const step = Math.max(1, Math.ceil(columns.length / 31))
  columns.forEach((column, index) => {
    const tick = element('span', 'report-axis-label', index % step === 0 ? column.label : '')
    if (column.weekend === true) tick.classList.add('report-axis-label--weekend')
    axis.append(tick)
  })
  scroll.append(plot, axis)
  return scroll
}

export interface Segment {
  key: string
  name: string
  color: string
}

export interface Stack {
  key: string
  label: string
  seconds: number
  parts: { segment: Segment; seconds: number }[]
}

export function stackedChart(label: string, stacks: Stack[], height: number): HTMLElement {
  const wrap = element('div', 'report-stacks-wrap')
  const plot = element('div', 'report-stacks')
  plot.setAttribute('role', 'group')
  plot.setAttribute('aria-label', label)
  plot.style.height = `${height}px`
  const peak = Math.max(...stacks.map((stack) => stack.seconds), 1)
  const room = height - 24
  for (const stack of stacks) {
    const column = element('div', 'report-stack')
    column.append(element('span', 'report-stack-total', hours(stack.seconds)))
    const pile = element('div', 'report-stack-pile')
    const visible = stack.parts.filter((part) => part.seconds > 0)
    visible.forEach((part, index) => {
      const block = element('div', 'report-stack-part')
      const tip = `${stack.label} · ${part.segment.name} · ${hours(part.seconds)}`
      block.title = tip
      block.setAttribute('role', 'img')
      block.setAttribute('aria-label', tip)
      block.style.height = `${Math.max((part.seconds / peak) * room, 2)}px`
      block.style.background = part.segment.color
      if (index === visible.length - 1) block.classList.add('report-stack-part--top')
      pile.append(block)
    })
    column.append(pile)
    plot.append(column)
  }
  const axis = element('div', 'report-stacks-axis')
  axis.setAttribute('aria-hidden', 'true')
  for (const stack of stacks) axis.append(element('span', undefined, stack.label))
  wrap.append(plot, axis)
  return wrap
}

export interface BarRow {
  name: string
  seconds: number
  color: string
}

export function barRows(rows: BarRow[], total: number): HTMLElement {
  const list = element('div', 'report-bars')
  const peak = Math.max(...rows.map((row) => row.seconds), 1)
  for (const row of rows) {
    const line = element('div', 'report-bar-row')
    const track = element('div', 'report-bar-track')
    const fill = element('div', 'report-bar-fill')
    fill.style.width = `${((row.seconds / peak) * 100).toFixed(1)}%`
    fill.style.background = row.color
    track.append(fill)
    const name = element('span', 'report-bar-name', row.name)
    name.title = row.name
    line.append(
      name,
      track,
      element('span', 'report-num', hours(row.seconds)),
      element('span', 'report-num report-num--mute', total > 0 ? `${Math.round((row.seconds / total) * 100)} %` : '0 %'),
    )
    list.append(line)
  }
  return list
}

export function legendItem(name: string, color: string): HTMLElement {
  const item = element('span', 'report-legend-item')
  item.append(swatch(color), element('span', undefined, name))
  return item
}

export function notice(text: string): HTMLElement {
  const box = element('div', 'banner banner--quiet report-notice')
  box.setAttribute('role', 'status')
  box.append(icon('warning', 13), element('span', undefined, text))
  return box
}

export function dateField(label: string, value: string, key: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = element('label', 'report-field') as HTMLLabelElement
  const input = document.createElement('input')
  input.type = 'date'
  input.value = value
  input.className = 'report-input'
  input.dataset['key'] = key
  wrap.append(element('span', 'report-field-label', label), input)
  return { label: wrap, input }
}
