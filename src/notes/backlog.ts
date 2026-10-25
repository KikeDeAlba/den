import type { BacklogItem, BacklogKind, Problem } from '../bita.ts'
import { element } from '../dom.ts'
import './backlog.css'

export type BacklogOrigin = 'meeting' | 'manual' | 'extracted'
type StatusFilter = 'open' | 'resolved' | 'all'
type CreatedFilter = 'any' | 'today' | 'week' | 'old'
type Grouping = 'page' | 'none'

export interface BacklogPage {
  pageId: number
  title: string
}

export interface BacklogContext {
  items: BacklogItem[] | null
  failure: Problem | null
  busy: Set<number>
  projectId: number | null | undefined
  spaceName: string | null
  pages: BacklogPage[]
  meetingEntryIds: Set<number>
  copied: string | null
  railOpen: boolean
  now: Date
}

export interface BacklogDraft {
  kind: BacklogKind
  title: string
  body: string
  pageId: number | null
}

export interface BacklogHandlers {
  onResolve: (id: number, resolution: string) => void
  onReopen: (id: number) => void
  onConvert: (id: number, kind: BacklogKind) => void
  onCreate: (draft: BacklogDraft) => Promise<void>
  onOpenPage: (pageId: number) => void
  onCopy: (text: string) => void
  onExpandRail: () => void
}

interface Filters {
  status: StatusFilter
  kinds: Set<BacklogKind>
  hiddenPages: Set<string>
  origins: Set<BacklogOrigin>
  created: CreatedFilter
}

interface Group {
  key: string
  title: string
  pageId: number | null
  items: BacklogItem[]
}

const DAY_MS = 86_400_000
const OLD_DAYS = 14
const WEEK_DAYS = 7
const KIND_COLOR: Record<BacklogKind, string> = { pending: 'var(--estimate)', finding: 'var(--purple)' }
const ORIGIN_LABEL: Record<BacklogOrigin, string> = {
  meeting: 'Reunión',
  manual: 'Manual',
  extracted: 'Extraído de una entrada',
}
const ALL_KINDS: BacklogKind[] = ['pending', 'finding']
const ALL_ORIGINS: BacklogOrigin[] = ['meeting', 'manual', 'extracted']

const PATHS: Record<string, string> = {
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
  filter: '<path d="M3 5h18l-7 8v6l-4 1v-7z"/>',
  group: '<path d="M4 6h16M7 12h10M10 18h4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  tick: '<path d="M6 12l4 4 8-9"/>',
  bang: '<path d="M12 7v6M12 17v.5"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  right: '<path d="M9 6l6 6-6 6"/>',
  meeting: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  manual: '<path d="M4 20l4-1 11-11-3-3L5 16z"/>',
  extracted: '<path d="M14 3H6v18h12V7z"/><path d="M14 3v4h4"/>',
  panel: '<rect x="3" y="4.5" width="18" height="15" rx="3"/><path d="M9.5 4.5v15"/>',
}

function glyph(name: keyof typeof PATHS, size = 13, weight = 2): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', String(weight))
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  svg.innerHTML = PATHS[name] ?? ''
  return svg
}

function button(className: string, ...children: (Node | string)[]): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.append(...children)
  return node
}

function defaultFilters(): Filters {
  return {
    status: 'open',
    kinds: new Set(ALL_KINDS),
    hiddenPages: new Set(),
    origins: new Set(ALL_ORIGINS),
    created: 'any',
  }
}

let ctx: BacklogContext | null = null
let actions: BacklogHandlers | null = null
let filters = defaultFilters()
let query = ''
let selectedId: number | null = null
let pendingFocus: number | null = null
let grouping: Grouping = 'page'
const collapsed = new Set<string>()
const drafts = new Map<number, string>()
let modal: 'filters' | 'create' | null = null
let createDraft: BacklogDraft = { kind: 'pending', title: '', body: '', pageId: null }
let createError: string | null = null
let creating = false

let root: HTMLElement | null = null
let main: HTMLElement | null = null
let listBody: HTMLElement | null = null
let detail: HTMLElement | null = null
let filterButton: HTMLButtonElement | null = null
let tally: HTMLElement | null = null
let crumb: HTMLElement | null = null
let unfold: HTMLButtonElement | null = null
let groupButton: HTMLButtonElement | null = null
let searchInput: HTMLInputElement | null = null
let overlay: HTMLElement | null = null
let columns: HTMLElement | null = null

export function itemKey(item: { id: number; key?: string }): string {
  return item.key ?? `#${item.id}`
}

function inScope(item: BacklogItem, projectId: number | null | undefined): boolean {
  return projectId === undefined || item.projectId === projectId
}

export function openCount(items: BacklogItem[] | null, projectId?: number | null): number {
  return (items ?? []).filter((item) => item.status === 'open' && inScope(item, projectId)).length
}

export function findByKey(items: BacklogItem[] | null, value: string): BacklogItem | undefined {
  const wanted = value.trim().replace(/^#/, '').toUpperCase()
  if (wanted.length === 0) return undefined
  return (items ?? []).find(
    (item) => itemKey(item).replace(/^#/, '').toUpperCase() === wanted || String(item.id) === wanted,
  )
}

export function originOf(item: BacklogItem, meetingEntryIds: Set<number>): BacklogOrigin {
  if (item.entryId !== null && meetingEntryIds.has(item.entryId)) return 'meeting'
  return item.source === 'extracted' ? 'extracted' : 'manual'
}

function pageKeyOf(item: BacklogItem): string {
  return item.pageId === null ? 'none' : String(item.pageId)
}

function daysSince(iso: string, now: Date): number {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 0
  return Math.max(0, Math.floor((now.getTime() - then) / DAY_MS))
}

function ageLabel(days: number): string {
  return days === 0 ? 'hoy' : `${days} d`
}

function dateLabel(iso: string | null): string {
  if (iso === null) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const day = date
    .toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
    .replace('.', '')
  const time = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day}, ${time}`
}

function scoped(): BacklogItem[] {
  if (ctx === null) return []
  const projectId = ctx.projectId
  return (ctx.items ?? []).filter((item) => inScope(item, projectId))
}

function matchesQuery(item: BacklogItem): boolean {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return true
  return [itemKey(item), item.title, item.body, item.pageTitle ?? '']
    .some((field) => field.toLowerCase().includes(needle))
}

function passes(item: BacklogItem, now: Date, meetingIds: Set<number>): boolean {
  if (filters.status !== 'all' && item.status !== filters.status) return false
  if (!filters.kinds.has(item.kind)) return false
  if (filters.hiddenPages.has(pageKeyOf(item))) return false
  if (!filters.origins.has(originOf(item, meetingIds))) return false
  const days = daysSince(item.createdAt, now)
  if (filters.created === 'today' && days !== 0) return false
  if (filters.created === 'week' && days > WEEK_DAYS) return false
  if (filters.created === 'old' && days <= OLD_DAYS) return false
  return true
}

function visible(): BacklogItem[] {
  if (ctx === null) return []
  const now = ctx.now
  const meetingIds = ctx.meetingEntryIds
  return scoped().filter((item) => passes(item, now, meetingIds) && matchesQuery(item))
}

function byRecency(left: BacklogItem, right: BacklogItem): number {
  if (left.status !== right.status) return left.status === 'open' ? -1 : 1
  return right.createdAt.localeCompare(left.createdAt) || right.id - left.id
}

function groupsOf(items: BacklogItem[]): Group[] {
  if (grouping === 'none') {
    return items.length === 0 ? [] : [{ key: 'all', title: 'Todos', pageId: null, items: [...items].sort(byRecency) }]
  }
  const groups = new Map<string, Group>()
  for (const item of items) {
    const key = pageKeyOf(item)
    const group = groups.get(key) ?? { key, title: item.pageTitle ?? 'Sin página', pageId: item.pageId, items: [] }
    group.items.push(item)
    groups.set(key, group)
  }
  const list = [...groups.values()]
  for (const group of list) group.items.sort(byRecency)
  return list.sort((left, right) => {
    if (left.pageId === null) return 1
    if (right.pageId === null) return -1
    return (right.items[0]?.createdAt ?? '').localeCompare(left.items[0]?.createdAt ?? '')
  })
}

function presentPages(): { key: string; title: string }[] {
  const seen = new Map<string, string>()
  for (const item of scoped()) {
    const key = pageKeyOf(item)
    if (!seen.has(key)) seen.set(key, item.pageTitle ?? 'Sin página')
  }
  return [...seen.entries()]
    .map(([key, title]) => ({ key, title }))
    .sort((left, right) => (left.key === 'none' ? 1 : right.key === 'none' ? -1 : left.title.localeCompare(right.title, 'es')))
}

function activeFilterCount(): number {
  let count = 0
  if (filters.status !== 'open') count += 1
  if (filters.kinds.size !== ALL_KINDS.length) count += 1
  if (filters.hiddenPages.size > 0) count += 1
  if (filters.origins.size !== ALL_ORIGINS.length) count += 1
  if (filters.created !== 'any') count += 1
  return count
}

function reveal(item: BacklogItem): void {
  if (filters.status !== 'all' && item.status !== filters.status) filters.status = 'all'
  filters.kinds.add(item.kind)
  filters.hiddenPages.delete(pageKeyOf(item))
  if (ctx !== null) filters.origins.add(originOf(item, ctx.meetingEntryIds))
  filters.created = 'any'
  collapsed.delete(grouping === 'page' ? pageKeyOf(item) : 'all')
  selectedId = item.id
}

export function focusBacklogItem(id: number): void {
  pendingFocus = id
  query = ''
  if (searchInput !== null) searchInput.value = ''
}

export function renderBacklog(host: HTMLElement, context: BacklogContext, handlers: BacklogHandlers): void {
  ctx = context
  actions = handlers
  if (root === null || root.parentElement !== host) build(host)

  if (pendingFocus !== null && context.items !== null) {
    const item = scoped().find((candidate) => candidate.id === pendingFocus)
    if (item !== undefined) reveal(item)
    pendingFocus = null
  }
  if (selectedId !== null && context.items !== null && !scoped().some((item) => item.id === selectedId)) {
    selectedId = null
  }

  const focus = rememberFocus()
  paintChrome()
  paintList()
  paintDetail()
  paintOverlay()
  restoreFocus(focus)
  if (pendingScroll) {
    pendingScroll = false
    listBody?.querySelector('.bl-row--on')?.scrollIntoView({ block: 'nearest' })
  }
}

let pendingScroll = false

function build(host: HTMLElement): void {
  root = element('div', 'bl')
  main = element('section', 'bl-main')
  main.setAttribute('aria-label', 'Backlog')

  const top = element('div', 'bl-top')
  unfold = button('icon-button bl-unfold', glyph('panel', 14))
  unfold.setAttribute('aria-label', 'Desplegar el árbol')
  unfold.addEventListener('click', () => actions?.onExpandRail())
  crumb = element('nav', 'bl-crumb')
  crumb.setAttribute('aria-label', 'Dónde estás')
  top.append(unfold, crumb)

  const head = element('div', 'bl-head')
  const title = element('h1', 'bl-title', 'Backlog')
  groupButton = button('bl-btn', glyph('group'), element('span', '', 'Agrupar: Página'))
  groupButton.addEventListener('click', () => {
    grouping = grouping === 'page' ? 'none' : 'page'
    paintChrome()
    paintList()
  })
  const create = button('bl-btn bl-btn--primary', glyph('plus', 13, 2.4), element('span', '', 'Crear'))
  create.addEventListener('click', () => openCreate())
  head.append(title, groupButton, create)

  const tools = element('div', 'bl-tools')
  const field = element('label', 'bl-search')
  searchInput = document.createElement('input')
  searchInput.type = 'search'
  searchInput.id = 'bl-query'
  searchInput.placeholder = 'Buscar en el backlog, o ir a una clave como STI-14'
  searchInput.autocomplete = 'off'
  searchInput.spellcheck = false
  searchInput.value = query
  searchInput.setAttribute('aria-label', 'Buscar en el backlog')
  searchInput.addEventListener('input', () => onQuery(searchInput?.value ?? ''))
  field.append(glyph('search', 12), searchInput)
  filterButton = button('bl-filter')
  filterButton.setAttribute('aria-haspopup', 'dialog')
  filterButton.addEventListener('click', () => {
    modal = modal === 'filters' ? null : 'filters'
    paintOverlay()
  })
  tally = element('span', 'bl-tally')
  tools.append(field, filterButton, tally)

  columns = element('div', 'bl-cols')
  for (const label of ['', 'Clave', 'Resumen', 'Página', 'Or.', 'Creado', 'Estado']) {
    const cell = element('span', '', label)
    if (label === 'Or.') cell.title = 'Origen'
    columns.append(cell)
  }

  listBody = element('div', 'bl-list')
  overlay = element('div', 'bl-overlay')
  main.append(top, head, tools, listBody, overlay)

  detail = element('aside', 'bl-detail')
  detail.setAttribute('aria-label', 'Detalle')
  root.append(main, detail)
  host.replaceChildren(root)
}

function onQuery(value: string): void {
  query = value
  const exact = findByKey(scoped(), value)
  if (exact !== undefined) {
    reveal(exact)
    pendingScroll = true
  }
  paintChrome()
  paintList()
  paintDetail()
  if (pendingScroll) {
    pendingScroll = false
    listBody?.querySelector('.bl-row--on')?.scrollIntoView({ block: 'nearest' })
  }
}

function paintChrome(): void {
  if (ctx === null || crumb === null || filterButton === null || tally === null) return
  unfold?.toggleAttribute('hidden', ctx.railOpen)
  root?.classList.toggle('bl--rail-closed', !ctx.railOpen)
  crumb.replaceChildren(
    element('span', '', ctx.spaceName ?? 'Todos los espacios'),
    element('span', 'bl-crumb-sep', '/'),
    element('span', '', 'Pendientes y hallazgos'),
  )
  groupButton?.replaceChildren(glyph('group'), element('span', '', grouping === 'page' ? 'Agrupar: Página' : 'Agrupar: Ninguno'))
  const active = activeFilterCount()
  filterButton.className = active > 0 ? 'bl-filter bl-filter--on' : 'bl-filter'
  filterButton.setAttribute('aria-expanded', String(modal === 'filters'))
  filterButton.replaceChildren(glyph('filter'), element('span', '', 'Filtros'))
  if (active > 0) filterButton.append(element('span', 'bl-badge', String(active)))
  tally.textContent = ctx.items === null ? '' : `${visible().length} de ${scoped().length}`
}

function paintList(): void {
  if (ctx === null || listBody === null) return
  const keep = listBody.scrollTop
  listBody.replaceChildren()
  if (columns !== null) listBody.append(columns)

  if (ctx.items === null) {
    listBody.append(ctx.failure !== null ? problemBlock(ctx.failure) : element('p', 'bl-empty', 'Leyendo el backlog…'))
    return
  }

  const shown = visible()
  if (shown.length === 0) {
    listBody.append(element('p', 'bl-empty', emptyText()))
    return
  }

  for (const group of groupsOf(shown)) {
    const closed = collapsed.has(group.key)
    const head = button(closed ? 'bl-group bl-group--closed' : 'bl-group')
    head.setAttribute('aria-expanded', String(!closed))
    const pending = group.items.filter((item) => item.kind === 'pending').length
    const findings = group.items.length - pending
    head.append(
      glyph(closed ? 'right' : 'down', 11, 2.4),
      element('span', 'bl-group-title', group.title),
      element('span', 'bl-mono', String(group.items.length)),
      element('span', 'bl-spacer'),
      element('span', 'bl-loz bl-loz--pending', `${pending} pend.`),
      element('span', 'bl-loz bl-loz--finding', `${findings} hallaz.`),
    )
    head.addEventListener('click', () => {
      if (collapsed.has(group.key)) collapsed.delete(group.key)
      else collapsed.add(group.key)
      paintList()
    })
    listBody.append(head)
    if (closed) continue
    const box = element('div', 'bl-box')
    for (const item of group.items) box.append(row(item))
    listBody.append(box)
  }
  listBody.scrollTop = keep
}

function typeMark(kind: BacklogKind): HTMLElement {
  const mark = element('span', 'bl-type')
  mark.style.background = KIND_COLOR[kind]
  mark.append(kind === 'finding' ? glyph('bang', 11, 2.6) : glyph('tick', 11, 2.6))
  mark.setAttribute('aria-label', kind === 'finding' ? 'Hallazgo' : 'Pendiente')
  return mark
}

function statusLozenge(item: BacklogItem): HTMLElement {
  return element(
    'span',
    item.status === 'resolved' ? 'bl-loz bl-loz--done' : 'bl-loz bl-loz--open',
    item.status === 'resolved' ? 'Resuelto' : 'Abierto',
  )
}

function row(item: BacklogItem): HTMLButtonElement {
  const context = ctx as BacklogContext
  const on = item.id === selectedId
  const node = button(on ? 'bl-row bl-row--on' : 'bl-row')
  node.dataset['id'] = String(item.id)
  node.setAttribute('aria-current', String(on))
  if (item.status === 'resolved') node.classList.add('bl-row--resolved')

  const page = element('span', 'bl-cell')
  page.append(element('span', 'bl-page', item.pageTitle ?? 'Sin página'))

  const origin = originOf(item, context.meetingEntryIds)
  const originCell = element('span', 'bl-origin')
  originCell.title = ORIGIN_LABEL[origin]
  originCell.append(glyph(origin))

  const status = element('span', 'bl-cell')
  status.append(statusLozenge(item))

  node.append(
    typeMark(item.kind),
    element('span', 'bl-key', itemKey(item)),
    element('span', 'bl-summary', item.title),
    page,
    originCell,
    element('span', 'bl-mono', ageLabel(daysSince(item.createdAt, context.now))),
    status,
  )
  node.addEventListener('click', () => select(item.id))
  return node
}

function select(id: number | null): void {
  selectedId = id
  if (listBody !== null) {
    for (const node of listBody.querySelectorAll<HTMLElement>('.bl-row')) {
      const on = node.dataset['id'] === String(id)
      node.classList.toggle('bl-row--on', on)
      node.setAttribute('aria-current', String(on))
    }
  }
  paintDetail()
}

function emptyText(): string {
  if (query.trim().length > 0) return `Nada coincide con «${query.trim()}».`
  if (scoped().length === 0) return 'Este espacio todavía no tiene pendientes ni hallazgos.'
  return 'Ningún elemento pasa los filtros.'
}

function problemBlock(failure: Problem): HTMLElement {
  const problem = element('div', 'problem')
  problem.append(element('p', 'problem-message', failure.message))
  if (failure.hint) problem.append(element('p', 'problem-hint', failure.hint))
  return problem
}

function selectedItem(): BacklogItem | undefined {
  if (selectedId === null) return undefined
  return scoped().find((item) => item.id === selectedId)
}

function paintDetail(): void {
  if (ctx === null || detail === null || root === null) return
  const item = selectedItem()
  root.classList.toggle('bl--detail', item !== undefined)
  if (item === undefined) {
    detail.replaceChildren()
    return
  }
  const context = ctx
  const key = itemKey(item)
  const resolved = item.status === 'resolved'
  const busy = context.busy.has(item.id)

  const bar = element('div', 'bl-detail-bar')
  const copy = button('bl-btn bl-btn--small', glyph(context.copied === key ? 'check' : 'copy', 12))
  copy.setAttribute('aria-label', context.copied === key ? 'Clave copiada' : 'Copiar la clave')
  copy.title = context.copied === key ? 'Copiada' : 'Copiar la clave'
  copy.addEventListener('click', () => actions?.onCopy(key))
  const close = button('bl-btn bl-btn--small', glyph('close', 12, 2.2))
  close.setAttribute('aria-label', 'Cerrar el detalle')
  close.addEventListener('click', () => select(null))
  bar.append(typeMark(item.kind), element('span', 'bl-key', key), element('span', 'bl-spacer'), copy, close)

  const body = element('div', 'bl-detail-body')
  body.append(element('h2', 'bl-detail-title', item.title))

  const buttons = element('div', 'bl-detail-actions')
  if (resolved) {
    const reopen = button('bl-btn', 'Reabrir')
    reopen.disabled = busy
    reopen.addEventListener('click', () => actions?.onReopen(item.id))
    buttons.append(reopen)
  } else {
    const resolve = button('bl-btn bl-btn--ok', 'Resolver')
    resolve.disabled = busy
    resolve.addEventListener('click', () => actions?.onResolve(item.id, drafts.get(item.id) ?? ''))
    buttons.append(resolve)
  }
  const other: BacklogKind = item.kind === 'finding' ? 'pending' : 'finding'
  const convert = button('bl-btn', other === 'pending' ? 'Convertir en pendiente' : 'Convertir en hallazgo')
  convert.disabled = busy
  convert.addEventListener('click', () => actions?.onConvert(item.id, other))
  buttons.append(convert)
  if (busy) buttons.append(element('span', 'bl-mono', 'Guardando…'))
  body.append(buttons)

  const facts = element('div', 'bl-kv')
  const fact = (label: string, value: Node | string): void => {
    const cell = element('span', '')
    cell.append(value)
    facts.append(element('span', 'bl-mono', label), cell)
  }
  fact('Estado', statusLozenge(item))
  fact('Tipo', item.kind === 'finding' ? 'Hallazgo' : 'Pendiente')
  if (item.pageId !== null) {
    const pageId = item.pageId
    const link = button('bl-link', item.pageTitle ?? 'Página')
    link.addEventListener('click', () => actions?.onOpenPage(pageId))
    fact('Página', link)
  } else {
    fact('Página', 'Sin página')
  }
  fact('Origen', ORIGIN_LABEL[originOf(item, context.meetingEntryIds)])
  const created = element('span', 'bl-mono bl-mono--fg', dateLabel(item.createdAt))
  fact('Creado', created)
  if (resolved) fact('Resuelto', element('span', 'bl-mono bl-mono--fg', dateLabel(item.resolvedAt)))
  if (item.entryId !== null) fact('Entrada', element('span', 'bl-mono bl-mono--fg', `#${item.entryId}`))
  body.append(facts)

  const description = element('div', 'bl-field')
  description.append(element('span', 'bl-label', 'Descripción'))
  description.append(
    element(
      'p',
      item.body.trim().length > 0 ? 'bl-text' : 'bl-text bl-text--none',
      item.body.trim().length > 0 ? item.body : 'Sin descripción.',
    ),
  )
  body.append(description)

  const resolution = element('label', 'bl-field')
  resolution.append(element('span', 'bl-label', 'Resolución'))
  if (resolved) {
    resolution.append(
      element(
        'p',
        item.resolution.trim().length > 0 ? 'bl-text' : 'bl-text bl-text--none',
        item.resolution.trim().length > 0 ? item.resolution : 'Se cerró sin nota.',
      ),
    )
  } else {
    const area = document.createElement('textarea')
    area.id = 'bl-resolution'
    area.className = 'bl-input bl-textarea'
    area.rows = 3
    area.placeholder = 'Cómo se resolvió…'
    area.value = drafts.get(item.id) ?? ''
    area.addEventListener('input', () => {
      drafts.set(item.id, area.value)
    })
    resolution.append(area)
  }
  body.append(resolution)

  if (item.pageId !== null) {
    const pageId = item.pageId
    const open = button('bl-btn', 'Abrir la página')
    open.addEventListener('click', () => actions?.onOpenPage(pageId))
    const foot = element('div', 'bl-detail-actions')
    foot.append(open)
    body.append(foot)
  }

  if (context.failure !== null && context.items !== null) body.append(problemBlock(context.failure))
  detail.replaceChildren(bar, body)
}

function paintOverlay(): void {
  if (overlay === null) return
  filterButton?.setAttribute('aria-expanded', String(modal === 'filters'))
  if (modal === null) {
    overlay.replaceChildren()
    overlay.hidden = true
    return
  }
  overlay.hidden = false
  const scrim = element('div', 'bl-scrim')
  scrim.addEventListener('click', closeModal)
  overlay.replaceChildren(scrim, modal === 'filters' ? filtersModal() : createModal())
}

function closeModal(): void {
  modal = null
  paintOverlay()
  filterButton?.focus()
}

function modalShell(titleText: string, id: string): { section: HTMLElement; body: HTMLElement; foot: HTMLElement } {
  const section = element('section', 'bl-modal')
  section.setAttribute('role', 'dialog')
  section.setAttribute('aria-modal', 'true')
  section.setAttribute('aria-labelledby', id)
  section.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation()
      closeModal()
    }
  })
  const head = element('div', 'bl-modal-head')
  const title = element('h2', 'bl-modal-title', titleText)
  title.id = id
  const close = button('bl-btn bl-btn--small', glyph('close', 12, 2.2))
  close.setAttribute('aria-label', `Cerrar ${titleText.toLowerCase()}`)
  close.addEventListener('click', closeModal)
  head.append(title, close)
  const body = element('div', 'bl-modal-body')
  const foot = element('div', 'bl-modal-foot')
  section.append(head, body, foot)
  return { section, body, foot }
}

function option(label: string, on: boolean, kind: 'radio' | 'check', toggle: () => void, dot?: string): HTMLButtonElement {
  const node = button('bl-op')
  node.setAttribute('aria-pressed', String(on))
  const indicator = element('span', kind === 'radio' ? 'bl-ind bl-ind--radio' : 'bl-ind bl-ind--check')
  indicator.setAttribute('aria-hidden', 'true')
  if (kind === 'check') indicator.append(glyph('check', 10, 4))
  node.append(indicator)
  if (dot !== undefined) {
    const bead = element('span', 'dot bl-op-dot')
    bead.style.background = dot
    node.append(bead)
  }
  node.append(element('span', '', label))
  node.addEventListener('click', toggle)
  return node
}

function fieldset(label: string, hint: string, options: HTMLElement[]): HTMLElement {
  const block = element('div', 'bl-fs')
  const head = element('div', 'bl-fs-head')
  head.append(element('span', 'bl-label', label), element('span', 'bl-hint', hint))
  const group = element('div', 'bl-opts')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', label)
  group.append(...options)
  block.append(head, group)
  return block
}

function refilter(): void {
  const focusedIndex = overlay === null ? -1 : [...overlay.querySelectorAll('button')].indexOf(document.activeElement as HTMLButtonElement)
  paintChrome()
  paintList()
  paintDetail()
  paintOverlay()
  if (focusedIndex >= 0) overlay?.querySelectorAll<HTMLButtonElement>('button')[focusedIndex]?.focus()
}

function toggleIn<T>(set: Set<T>, value: T): void {
  if (set.has(value)) set.delete(value)
  else set.add(value)
}

function filtersModal(): HTMLElement {
  const { section, body, foot } = modalShell('Filtros', 'bl-filters-title')
  const radio = <T>(current: T, value: T, label: string, set: (value: T) => void): HTMLButtonElement =>
    option(label, current === value, 'radio', () => {
      set(value)
      refilter()
    })

  body.append(
    fieldset('Estado', 'elige uno', [
      radio<StatusFilter>(filters.status, 'open', 'Abiertos', (value) => (filters.status = value)),
      radio<StatusFilter>(filters.status, 'resolved', 'Resueltos', (value) => (filters.status = value)),
      radio<StatusFilter>(filters.status, 'all', 'Todos', (value) => (filters.status = value)),
    ]),
    fieldset(
      'Tipo',
      'uno o varios',
      ALL_KINDS.map((kind) =>
        option(
          kind === 'pending' ? 'Pendiente' : 'Hallazgo',
          filters.kinds.has(kind),
          'check',
          () => {
            toggleIn(filters.kinds, kind)
            refilter()
          },
          KIND_COLOR[kind],
        ),
      ),
    ),
  )

  const pages = presentPages()
  if (pages.length > 0) {
    body.append(
      fieldset(
        'Página',
        'uno o varios',
        pages.map((page) =>
          option(page.title, !filters.hiddenPages.has(page.key), 'check', () => {
            toggleIn(filters.hiddenPages, page.key)
            refilter()
          }),
        ),
      ),
    )
  }

  body.append(
    fieldset(
      'Origen',
      'uno o varios',
      ([
        ['meeting', 'Reunión'],
        ['manual', 'Manual'],
        ['extracted', 'Extraído'],
      ] as const).map(([origin, label]) =>
        option(label, filters.origins.has(origin), 'check', () => {
          toggleIn(filters.origins, origin)
          refilter()
        }),
      ),
    ),
    fieldset('Creado', 'elige uno', [
      radio<CreatedFilter>(filters.created, 'any', 'Cuando sea', (value) => (filters.created = value)),
      radio<CreatedFilter>(filters.created, 'today', 'Hoy', (value) => (filters.created = value)),
      radio<CreatedFilter>(filters.created, 'week', 'Esta semana', (value) => (filters.created = value)),
      radio<CreatedFilter>(filters.created, 'old', 'Más de 2 semanas', (value) => (filters.created = value)),
    ]),
  )

  const reset = button('bl-btn', 'Limpiar')
  reset.addEventListener('click', () => {
    filters = defaultFilters()
    refilter()
  })
  const count = visible().length
  const done = button('bl-btn bl-btn--primary', `Ver ${count} ${count === 1 ? 'elemento' : 'elementos'}`)
  done.addEventListener('click', closeModal)
  foot.append(reset, element('span', 'bl-spacer'), done)
  window.requestAnimationFrame(() => {
    if (!section.contains(document.activeElement)) section.querySelector<HTMLButtonElement>('.bl-op')?.focus()
  })
  return section
}

function openCreate(): void {
  const firstPage = ctx?.pages[0]?.pageId ?? null
  createDraft = { kind: 'pending', title: '', body: '', pageId: createDraft.pageId ?? firstPage }
  if (createDraft.pageId !== null && !(ctx?.pages ?? []).some((page) => page.pageId === createDraft.pageId)) {
    createDraft.pageId = firstPage
  }
  createError = null
  modal = 'create'
  paintOverlay()
  overlay?.querySelector<HTMLInputElement>('#bl-create-title')?.focus()
}

function createModal(): HTMLElement {
  const { section, body, foot } = modalShell('Crear en el backlog', 'bl-create-heading')
  const kinds = element('div', 'bl-opts')
  kinds.setAttribute('role', 'radiogroup')
  kinds.setAttribute('aria-label', 'Tipo')
  for (const kind of ALL_KINDS) {
    kinds.append(
      option(kind === 'pending' ? 'Pendiente' : 'Hallazgo', createDraft.kind === kind, 'radio', () => {
        createDraft.kind = kind
        for (const node of kinds.querySelectorAll<HTMLElement>('.bl-op')) {
          node.setAttribute('aria-pressed', String(node === kinds.children[ALL_KINDS.indexOf(kind)]))
        }
      }, KIND_COLOR[kind]),
    )
  }
  const typeBlock = element('div', 'bl-fs')
  const typeHead = element('div', 'bl-fs-head')
  typeHead.append(element('span', 'bl-label', 'Tipo'))
  typeBlock.append(typeHead, kinds)

  const titleBlock = element('label', 'bl-fs')
  titleBlock.append(element('span', 'bl-label', 'Título'))
  const title = document.createElement('input')
  title.id = 'bl-create-title'
  title.className = 'bl-input'
  title.placeholder = 'Qué falta o qué se encontró'
  title.value = createDraft.title
  title.addEventListener('input', () => {
    createDraft.title = title.value
    submit.disabled = creating || title.value.trim().length === 0
  })
  titleBlock.append(title)

  const bodyBlock = element('label', 'bl-fs')
  bodyBlock.append(element('span', 'bl-label', 'Descripción'))
  const text = document.createElement('textarea')
  text.id = 'bl-create-body'
  text.className = 'bl-input bl-textarea'
  text.rows = 4
  text.placeholder = 'El contexto que hará falta para cerrarlo'
  text.value = createDraft.body
  text.addEventListener('input', () => {
    createDraft.body = text.value
  })
  bodyBlock.append(text)

  const pageBlock = element('label', 'bl-fs')
  pageBlock.append(element('span', 'bl-label', 'Página'))
  const select = document.createElement('select')
  select.id = 'bl-create-page'
  select.className = 'bl-input'
  const none = document.createElement('option')
  none.value = ''
  none.textContent = 'Sin página'
  select.append(none)
  for (const page of ctx?.pages ?? []) {
    const choice = document.createElement('option')
    choice.value = String(page.pageId)
    choice.textContent = page.title
    select.append(choice)
  }
  select.value = createDraft.pageId === null ? '' : String(createDraft.pageId)
  select.addEventListener('change', () => {
    createDraft.pageId = select.value === '' ? null : Number(select.value)
  })
  pageBlock.append(select)

  body.append(typeBlock, titleBlock, bodyBlock, pageBlock)
  if (createError !== null) body.append(element('p', 'bl-error', createError))

  const cancel = button('bl-btn', 'Cancelar')
  cancel.addEventListener('click', closeModal)
  const submit = button('bl-btn bl-btn--primary', creating ? 'Creando…' : 'Crear')
  submit.disabled = creating || createDraft.title.trim().length === 0
  submit.addEventListener('click', () => {
    void submitCreate()
  })
  foot.append(cancel, element('span', 'bl-spacer'), submit)
  section.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !submit.disabled) void submitCreate()
  })
  return section
}

async function submitCreate(): Promise<void> {
  if (actions === null || creating || createDraft.title.trim().length === 0) return
  creating = true
  createError = null
  paintOverlay()
  try {
    await actions.onCreate({ ...createDraft, title: createDraft.title.trim(), body: createDraft.body.trim() })
    creating = false
    createDraft = { kind: createDraft.kind, title: '', body: '', pageId: createDraft.pageId }
    modal = null
  } catch (error) {
    creating = false
    createError =
      typeof error === 'object' && error !== null && 'message' in error
        ? String((error as { message: unknown }).message)
        : String(error)
  }
  paintOverlay()
}

interface FocusMemo {
  id: string
  start: number | null
  end: number | null
}

function rememberFocus(): FocusMemo | null {
  const active = document.activeElement
  if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) || active.id === '') return null
  return { id: active.id, start: active.selectionStart, end: active.selectionEnd }
}

function restoreFocus(memo: FocusMemo | null): void {
  if (memo === null || root === null) return
  const target = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${CSS.escape(memo.id)}`)
  if (target === null || target === document.activeElement) return
  target.focus()
  if (memo.start !== null && memo.end !== null) target.setSelectionRange(memo.start, memo.end)
}
