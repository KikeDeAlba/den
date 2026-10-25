import type { PageNode, Space } from '../bita.ts'
import { element, icon } from '../dom.ts'
import { projectColor } from '../tabs.ts'
import { isRemote, latestMeeting } from './meeting.ts'
import type { PageResult, SearchScope } from './search.ts'
import { formatBytes } from './media-dialogs.ts'
import { withPages } from './switcher.ts'
import './spaces.css'
import { modKey } from '../platform.ts'

export type SelectionKind = 'page' | 'entry' | 'backlog' | 'meetings' | 'storage' | 'space-settings' | 'atlassian'

export type Selection = { kind: SelectionKind; id: number } | null

export interface RailHandlers {
  onQuery: (value: string) => void
  onScope: (scope: SearchScope) => void
  onToggle: (key: string) => void
  onSelectPage: (pageId: number) => void
  onSelectResult: (result: PageResult) => void
  onSelectBacklog: () => void
  onSelectMeetings: () => void
  onSelectStorage: () => void
  onSelectSettings: () => void
  onSwitcher: (anchor: HTMLElement) => void
  onSpace: (slug: string) => void
  onCollapse: () => void
  onExpand: () => void
}

export interface RailState {
  spaces: Space[]
  active: Space | null
  client: string | null
  expanded: Set<string>
  selected: Selection
  query: string
  scope: SearchScope
  results: PageResult[] | null
  loading: boolean
  open: boolean
  backlogOpen: number | null
  meetingCount: number
  storageBytes: number | null
  showBacklog: boolean
  showMeetings: boolean
}

export function spaceKey(space: Space): string {
  return `space:${space.projectSlug}`
}

export function pageKey(page: PageNode): string {
  return `page:${page.pageId}`
}

export function formatSize(bytes: number): string {
  return formatBytes(bytes)
}

export function renderRail(host: HTMLElement, state: RailState, handlers: RailHandlers): void {
  host.classList.toggle('rail--closed', !state.open)

  if (!state.open) {
    host.replaceChildren(collapsedStrip(state, handlers))
    return
  }

  const standing = host.querySelector<HTMLInputElement>('#rail-query')
  const parts = standing === null ? freshChrome(host, state, handlers) : keepChrome(host, standing, state)

  parts.top.replaceChildren(switcherButton(state, handlers))
  parts.scope.replaceChildren(...scopeToggle(state, handlers))
  parts.foot.replaceChildren(...footRows(state, handlers))

  if (state.query.trim().length > 0) {
    renderResults(parts.body, state, handlers)
    return
  }
  if (state.showBacklog) parts.body.append(fixedRow('inbox', 'Pendientes y hallazgos', state.backlogOpen, state.selected?.kind === 'backlog', handlers.onSelectBacklog))
  if (state.showMeetings) parts.body.append(fixedRow('calendar', 'Reuniones', state.meetingCount, state.selected?.kind === 'meetings', handlers.onSelectMeetings))
  renderTree(parts.body, state, handlers)
}

interface Chrome {
  top: HTMLElement
  scope: HTMLElement
  body: HTMLElement
  foot: HTMLElement
}

function freshChrome(host: HTMLElement, state: RailState, handlers: RailHandlers): Chrome {
  const head = element('div', 'rail-head')
  head.setAttribute('data-tauri-drag-region', '')
  const fold = document.createElement('button')
  fold.type = 'button'
  fold.className = 'icon-button'
  fold.setAttribute('aria-label', 'Plegar el árbol')
  fold.append(icon('panelLeft', 13))
  fold.addEventListener('click', handlers.onCollapse)
  head.append(element('span', 'spacer'), fold)

  const top = element('div', 'rail-top')

  const search = element('div', 'rail-search')
  const field = element('label', 'search-field')
  const glass = element('span', 'search-glass')
  glass.append(icon('search', 13))
  const input = document.createElement('input')
  input.type = 'search'
  input.id = 'rail-query'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.value = state.query
  input.addEventListener('input', () => {
    handlers.onQuery(input.value)
  })
  field.append(glass, input)
  const scope = element('div', 'rail-scope')
  search.append(field, scope)

  const body = element('div', 'rail-body')
  body.setAttribute('role', 'tree')

  const foot = element('div', 'rail-foot')
  host.replaceChildren(head, top, search, body, foot)
  placeholder(input, state)
  return { top, scope, body, foot }
}

function keepChrome(host: HTMLElement, input: HTMLInputElement, state: RailState): Chrome {
  if (input.value !== state.query) input.value = state.query
  placeholder(input, state)
  const body = host.querySelector<HTMLElement>('.rail-body') as HTMLElement
  body.replaceChildren()
  return {
    top: host.querySelector<HTMLElement>('.rail-top') as HTMLElement,
    scope: host.querySelector<HTMLElement>('.rail-scope') as HTMLElement,
    body,
    foot: host.querySelector<HTMLElement>('.rail-foot') as HTMLElement,
  }
}

function placeholder(input: HTMLInputElement, state: RailState): void {
  const name = state.active?.projectName ?? null
  const text = state.scope === 'space' && name !== null ? `Buscar páginas en ${name}` : 'Buscar en todos los espacios'
  input.placeholder = text
  input.setAttribute('aria-label', text)
  const body = input.closest('.rail-search')?.parentElement?.querySelector('.rail-body')
  body?.setAttribute('aria-label', name === null ? 'Páginas' : `Páginas de ${name}`)
}

function switcherButton(state: RailState, handlers: RailHandlers): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'space-switch'
  button.id = 'space-switch'
  button.setAttribute('aria-haspopup', 'listbox')
  button.setAttribute('aria-expanded', 'false')
  const space = state.active
  const dot = element('span', 'dot')
  dot.style.background = space === null ? 'var(--fg-faint)' : projectColor(space.projectId)
  const lines = element('span', 'space-switch-lines')
  lines.append(element('span', 'space-switch-name', space?.projectName ?? 'Elige un espacio'))
  if (space !== null) {
    const pages = `${space.pageCount} ${space.pageCount === 1 ? 'página' : 'páginas'}`
    lines.append(element('span', 'space-switch-meta', state.client === null ? pages : `${state.client} · ${pages}`))
  }
  button.append(dot, lines, icon('chevronDown', 12))
  button.title = `Cambiar de espacio (${modKey('K')})`
  button.addEventListener('click', () => handlers.onSwitcher(button))
  return button
}

function scopeToggle(state: RailState, handlers: RailHandlers): HTMLElement[] {
  if (state.query.trim().length === 0) return []
  const group = element('div', 'seg')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Alcance de la búsqueda')
  for (const [value, label] of [
    ['space', 'Este espacio'],
    ['all', 'Todos'],
  ] as const) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = label
    button.setAttribute('aria-pressed', String(state.scope === value))
    button.addEventListener('click', () => handlers.onScope(value))
    group.append(button)
  }
  return [group]
}

function fixedRow(
  glyph: 'inbox' | 'calendar' | 'database' | 'sliders',
  label: string,
  count: number | string | null,
  on: boolean,
  onClick: () => void,
): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = on ? 'fixed-row fixed-row--on' : 'fixed-row'
  row.setAttribute('aria-current', on ? 'page' : 'false')
  const mark = element('span', 'fixed-row-icon')
  mark.append(icon(glyph, 13))
  row.append(mark, element('span', 'fixed-row-name', label))
  if (typeof count === 'number' && count > 0) row.append(element('span', 'project-count', String(count)))
  if (typeof count === 'string') row.append(element('span', 'fixed-row-size', count))
  row.addEventListener('click', onClick)
  return row
}

function footRows(state: RailState, handlers: RailHandlers): HTMLElement[] {
  return [
    fixedRow(
      'database',
      'Almacenamiento',
      state.storageBytes === null ? '' : formatSize(state.storageBytes),
      state.selected?.kind === 'storage',
      handlers.onSelectStorage,
    ),
    fixedRow(
      'sliders',
      'Ajustes del espacio',
      null,
      state.selected?.kind === 'space-settings' || state.selected?.kind === 'atlassian',
      handlers.onSelectSettings,
    ),
  ]
}

function collapsedStrip(state: RailState, handlers: RailHandlers): HTMLElement {
  const strip = element('div', 'rail-strip')
  strip.setAttribute('data-tauri-drag-region', '')

  const unfold = document.createElement('button')
  unfold.type = 'button'
  unfold.className = 'strip-icon'
  unfold.setAttribute('aria-label', 'Desplegar el árbol')
  unfold.append(icon('panelLeft', 14))
  unfold.addEventListener('click', handlers.onExpand)
  strip.append(unfold)

  const shortcuts = [
    ['inbox', 'Pendientes y hallazgos', handlers.onSelectBacklog, state.showBacklog],
    ['calendar', 'Reuniones', handlers.onSelectMeetings, state.showMeetings],
  ] as const
  for (const [glyph, label, run, shown] of shortcuts) {
    if (!shown) continue
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'strip-icon'
    button.setAttribute('aria-label', label)
    button.append(icon(glyph, 14))
    button.addEventListener('click', run)
    strip.append(button)
  }

  for (const space of withPages(state.spaces)) {
    const dot = document.createElement('button')
    dot.type = 'button'
    dot.className = space.projectSlug === state.active?.projectSlug ? 'strip-dot strip-dot--on' : 'strip-dot'
    dot.setAttribute('aria-label', `Espacio ${space.projectName ?? 'sin proyecto'}`)
    dot.title = space.projectName ?? 'Sin proyecto'
    const bead = element('span', 'dot')
    bead.style.background = projectColor(space.projectId)
    dot.append(bead)
    dot.addEventListener('click', () => handlers.onSpace(space.projectSlug))
    strip.append(dot)
  }

  return strip
}

function renderTree(body: HTMLElement, state: RailState, handlers: RailHandlers): void {
  body.append(element('div', 'rail-label', 'Páginas'))
  const space = state.active
  if (space === null) {
    body.append(element('p', 'rail-empty', state.loading ? 'Leyendo…' : 'Todavía no hay nada medido.'))
    return
  }
  if (space.pages.length === 0) {
    body.append(element('p', 'rail-empty', 'Ninguna página en este espacio.'))
    return
  }
  for (const page of space.pages) body.append(...pageBlock(page, state, handlers, 1))
}

function pageBlock(page: PageNode, state: RailState, handlers: RailHandlers, level: number): HTMLElement[] {
  const key = pageKey(page)
  const kids = page.children ?? []
  const open = state.expanded.has(key)
  const on = state.selected?.kind === 'page' && state.selected.id === page.pageId

  const row = document.createElement('button')
  row.type = 'button'
  row.className = on ? 'page-row page-row--on' : 'page-row'
  row.setAttribute('role', 'treeitem')
  row.setAttribute('aria-level', String(level))
  row.setAttribute('aria-selected', String(on))
  row.style.setProperty('--level', String(level - 1))
  if (kids.length > 0) row.setAttribute('aria-expanded', String(open))

  const chevron = element('span', 'page-chevron')
  if (kids.length > 0) {
    chevron.append(icon(open ? 'chevronDown' : 'chevronRight', 11))
    chevron.addEventListener('click', (event) => {
      event.stopPropagation()
      handlers.onToggle(key)
    })
  }

  row.append(chevron)
  const meeting = latestMeeting(page.meetings)
  if (meeting !== null) {
    const glyph = element('span', isRemote(meeting) ? 'page-meeting page-meeting--remote' : 'page-meeting')
    glyph.setAttribute('aria-label', isRemote(meeting) ? 'Salió de una reunión remota' : 'Salió de una reunión presencial')
    glyph.append(icon(isRemote(meeting) ? 'screen' : 'mic', 12))
    row.append(glyph)
  }
  row.append(element('span', 'page-name', page.title))
  if (page.issues.length > 0) row.append(element('span', 'page-count', String(page.issues.length)))

  row.addEventListener('click', () => {
    handlers.onSelectPage(page.pageId)
    if (kids.length > 0 && !open) handlers.onToggle(key)
  })

  if (kids.length === 0 || !open) return [row]

  const nest = element('div', 'page-children')
  for (const child of kids) nest.append(...pageBlock(child, state, handlers, level + 1))
  return [row, nest]
}

function renderResults(body: HTMLElement, state: RailState, handlers: RailHandlers): void {
  if (state.results === null) {
    body.append(element('p', 'rail-empty', 'Buscando…'))
    return
  }

  if (state.results.length === 0) {
    body.append(element('p', 'rail-empty', `Nada coincide con «${state.query.trim()}».`))
    return
  }

  const total = state.results.reduce((sum, result) => sum + result.matchCount, 0)
  const tally = element('div', 'rail-tally')
  tally.append(
    element('span', 'rail-label-inline', `${state.results.length} ${state.results.length === 1 ? 'página' : 'páginas'}`),
    element('span', 'kbd', `${total} ${total === 1 ? 'coincidencia' : 'coincidencias'}`),
  )
  body.append(tally)

  let project = '\u0000'
  for (const result of state.results) {
    if (state.scope === 'all' && result.projectSlug !== project) {
      project = result.projectSlug
      const header = element('div', 'result-project')
      const dot = element('span', 'dot')
      dot.style.background = projectColor(result.projectId)
      header.append(dot, element('span', '', result.projectName ?? 'Sin proyecto'))
      body.append(header)
    }
    const on = state.selected?.kind === 'page' && state.selected.id === result.pageId
    body.append(resultRow(result, on, handlers))
  }
}

function resultRow(result: PageResult, selected: boolean, handlers: RailHandlers): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = selected ? 'result-row result-row--on' : 'result-row'
  row.setAttribute('aria-current', String(selected))

  const head = element('span', 'result-head')
  head.append(element('span', 'result-title', result.title), element('span', 'result-count', String(result.matchCount)))
  row.append(head, element('span', 'result-crumb', result.crumb))

  if (result.snippet !== null) {
    const snippet = element('span', 'result-snippet')
    snippet.append(document.createTextNode(`…${result.snippet.prefix.trimStart()}`))
    snippet.append(element('mark', 'hit', result.snippet.match))
    snippet.append(document.createTextNode(`${result.snippet.suffix.trimEnd()}…`))
    row.append(snippet)
  }

  const sources = element('span', 'result-sources')
  if (result.page > 0) sources.append(element('span', 'result-source', `página ${result.page}`))
  if (result.entries > 0) sources.append(element('span', 'result-source', `entradas ${result.entries}`))
  if (result.transcript > 0) sources.append(element('span', 'result-source', `transcripción ${result.transcript}`))
  if (sources.childElementCount > 0) row.append(sources)

  row.addEventListener('click', () => {
    handlers.onSelectResult(result)
  })
  return row
}
