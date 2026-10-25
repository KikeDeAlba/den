import {
  backlogAdd,
  backlogList,
  backlogSetKind,
  backlogSetStatus,
  copyText,
  describeProblem,
  notesTree,
  toolsStatus,
  type BacklogItem,
  type BacklogKind,
  type Modules,
  type PageNode,
  type Problem,
  type Space,
} from '../../bita.ts'
import { element, icon } from '../../dom.ts'
import { closeSwitcher, isSwitcherOpen, toggleSwitcher, withPages } from '../../notes/switcher.ts'
import { modKey } from '../../platform.ts'
import { formatRoute, go, parseRoute } from '../../shell/routes.ts'
import { isSpaceShortcut, onSpaceChange, rememberedSpace, rememberSpace } from '../../shell/space.ts'
import { projectColor } from '../../shell/colors.ts'
import {
  activeFilters,
  ageLabel,
  ALL_PAGES,
  closePrompt,
  defaultFilters,
  findKey,
  groupByPage,
  groupIssues,
  inSpace,
  keyOf,
  matches,
  meetingEntryIds,
  ORIGIN_LABEL,
  originOf,
  otherKind,
  pagesOf,
  passes,
  STATE_LABEL,
  stateOf,
  type BacklogOrigin,
  type CreatedFilter,
  type Filters,
  type Grouping,
  type IssueGroup,
  type IssueState,
  type StatusFilter,
} from './model.ts'
import type { ShellEvent } from '../section.ts'
import { pageRoute, parsePendientesPath, pendientesRoute, type PendientesTarget } from '../../shell/links.ts'
import './pendientes.css'

type Layout = 'list' | 'board'

interface Draft {
  kind: BacklogKind
  title: string
  body: string
  pageId: number | null
}

const LAYOUT_KEY = 'den.pendientes.layout'
const GROUPING_KEY = 'den.pendientes.grouping'
const COPIED_MS = 1500
const STATE_CLASS: Record<IssueState, string> = {
  finding: 'pend-tone--finding',
  pending: 'pend-tone--pending',
  resolved: 'pend-tone--resolved',
}

let host: HTMLElement | null = null
let alive = false
let listening = false
let stopSpaceWatch: (() => void) | null = null

let spaces: Space[] = []
let items: BacklogItem[] | null = null
let failure: Problem | null = null
let actionFailure: string | null = null
let modules: Modules | null = null
let activeSpace: string | null = rememberedSpace()
let routeSpace: string | null = null
let selectedId: number | null = null
let query = ''
let layout: Layout = rememberedLayout()
let grouping: Grouping = rememberedGrouping()
let filters: Filters = defaultFilters()
let filtersOpen = false
let meetingIds = new Set<number>()
let loadTicket = 0
let shownSignature: string | null = null
let creating: Draft | null = null
let saving = false
let copied: string | null = null
let copiedTimer = 0
let pendingKey: string | null = null
const busy = new Set<number>()
const resolutions = new Map<number, string>()

function rememberedLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'board' ? 'board' : 'list'
  } catch {
    return 'list'
  }
}

function rememberedGrouping(): Grouping {
  try {
    return localStorage.getItem(GROUPING_KEY) === 'page' ? 'page' : 'state'
  } catch {
    return 'state'
  }
}

function setGrouping(next: Grouping): void {
  grouping = next
  try {
    localStorage.setItem(GROUPING_KEY, next)
  } catch {
    grouping = next
  }
  paint()
}

function setFilter<K extends keyof Filters>(key: K, value: Filters[K]): void {
  filters = { ...filters, [key]: value }
  paint()
}

function setLayout(next: Layout): void {
  layout = next
  try {
    localStorage.setItem(LAYOUT_KEY, next)
  } catch {
    layout = next
  }
  paint()
}

function available(): boolean {
  return modules === null || modules.backlog
}

function currentSpace(): Space | null {
  return spaces.find((space) => space.projectSlug === activeSpace) ?? null
}

function spaceItems(): BacklogItem[] {
  const space = currentSpace()
  if (space === null || items === null) return []
  return items.filter((item) => inSpace(item, space.projectId))
}

function shownItems(): BacklogItem[] {
  const now = new Date()
  return spaceItems().filter((item) => matches(item, query) && passes(item, filters, now, meetingIds))
}

function selectedItem(): BacklogItem | null {
  return spaceItems().find((item) => item.id === selectedId) ?? null
}

function spacePages(space: Space | null): { pageId: number; title: string }[] {
  const pages: { pageId: number; title: string }[] = []
  const walk = (list: readonly PageNode[], prefix: string): void => {
    for (const page of list) {
      pages.push({ pageId: page.pageId, title: `${prefix}${page.title}` })
      walk(page.children ?? [], `${prefix}${page.title} / `)
    }
  }
  walk(space?.pages ?? [], '')
  return pages
}

function visible(): boolean {
  return host !== null && !host.hidden
}

function reflectRoute(): void {
  if (!visible()) return
  const item = selectedItem()
  const parsed = parseRoute(pendientesRoute(activeSpace, item === null ? null : keyOf(item)))
  if (parsed === null) return
  const next = formatRoute(parsed)
  if (location.hash !== next) history.replaceState(null, '', next)
}

function chooseDefaultSpace(): void {
  if (spaces.some((space) => space.projectSlug === activeSpace)) return
  activeSpace = (withPages(spaces)[0] ?? spaces[0])?.projectSlug ?? null
}

function switchSpace(slug: string): void {
  if (!spaces.some((space) => space.projectSlug === slug)) return
  rememberSpace(slug)
  if (slug === activeSpace) return
  activeSpace = slug
  selectedId = null
  creating = null
  paint()
  reflectRoute()
}

function select(id: number | null): void {
  selectedId = id
  creating = null
  actionFailure = null
  paint()
  reflectRoute()
}

function jumpTo(item: BacklogItem): void {
  const owner = spaces.find((space) => inSpace(item, space.projectId))
  if (owner !== undefined && owner.projectSlug !== activeSpace) {
    activeSpace = owner.projectSlug
    rememberSpace(owner.projectSlug)
  }
  query = ''
  if (!passes(item, filters, new Date(), meetingIds)) filters = defaultFilters()
  select(item.id)
}

function applyTarget(target: PendientesTarget): void {
  if (items === null || spaces.length === 0) {
    if (target.space !== null) activeSpace = target.space
    routeSpace = target.space
    pendingKey = target.key
    return
  }
  if (target.space !== null) switchSpace(target.space)
  if (target.key !== null) {
    const item = findKey(items, target.key)
    if (item !== undefined && item.id !== selectedId) jumpTo(item)
  }
  reflectRoute()
}

function signature(): string {
  return JSON.stringify([modules?.backlog ?? null, activeSpace, selectedId, failure, spaces, items])
}

async function load(): Promise<void> {
  const mine = ++loadTicket
  let status: Modules | null
  try {
    status = (await toolsStatus()).modules
  } catch {
    status = null
  }
  if (mine !== loadTicket) return
  modules = status
  if (!available()) {
    items = []
    refresh()
    return
  }
  const [tree, list] = await Promise.allSettled([notesTree(), backlogList()])
  if (mine !== loadTicket) return
  if (tree.status === 'fulfilled') {
    spaces = tree.value.data.spaces ?? []
    meetingIds = meetingEntryIds(spaces)
  }
  if (list.status === 'fulfilled') {
    items = list.value.data
    failure = null
  } else {
    failure = describeProblem(list.reason)
    items = items ?? []
  }
  if (tree.status === 'rejected' && failure === null) failure = describeProblem(tree.reason)
  chooseDefaultSpace()
  if (routeSpace !== null && routeSpace === activeSpace) rememberSpace(routeSpace)
  routeSpace = null
  if (pendingKey !== null) {
    const key = pendingKey
    pendingKey = null
    const item = findKey(items, key)
    if (item !== undefined) jumpTo(item)
  }
  if (selectedId !== null && selectedItem() === null) selectedId = null
  refresh()
}

function refresh(): void {
  if (shownSignature !== null && shownSignature === signature() && host?.querySelector('.pend') !== null) return
  paint()
}

function copy(text: string): void {
  void copyText(text)
    .then(() => {
      copied = text
      window.clearTimeout(copiedTimer)
      copiedTimer = window.setTimeout(() => {
        copied = null
        paint()
      }, COPIED_MS)
      paint()
    })
    .catch((error: unknown) => {
      actionFailure = describeProblem(error).message
      paint()
    })
}

function change(id: number, run: () => Promise<{ data: BacklogItem }>): void {
  busy.add(id)
  actionFailure = null
  paint()
  void (async () => {
    try {
      const payload = await run()
      items = (items ?? []).map((item) => (item.id === id ? { ...item, ...payload.data } : item))
      resolutions.delete(id)
    } catch (error) {
      actionFailure = describeProblem(error).message
    }
    busy.delete(id)
    paint()
  })()
}

function resolve(item: BacklogItem): void {
  const note = (resolutions.get(item.id) ?? '').trim()
  change(item.id, () => backlogSetStatus(item.id, 'resolved', note.length > 0 ? note : null))
}

function reopen(item: BacklogItem): void {
  change(item.id, () => backlogSetStatus(item.id, 'open', null))
}

function convert(item: BacklogItem, kind: BacklogKind): void {
  change(item.id, () => backlogSetKind(item.id, kind))
}

async function create(draft: Draft): Promise<void> {
  const title = draft.title.trim()
  if (title.length === 0 || saving) return
  saving = true
  actionFailure = null
  paint()
  try {
    const body = draft.body.trim()
    const payload = await backlogAdd(draft.kind, title, body.length > 0 ? body : null, draft.pageId, activeSpace)
    items = [...(items ?? []), payload.data]
    creating = null
    selectedId = payload.data.id
    reflectRoute()
  } catch (error) {
    actionFailure = describeProblem(error).message
  }
  saving = false
  paint()
}

function textButton(className: string, label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.textContent = label
  button.addEventListener('click', run)
  return button
}

function dot(className: string, color?: string): HTMLElement {
  const mark = element('span', className)
  if (color !== undefined) mark.style.background = color
  return mark
}

function header(): HTMLElement {
  const bar = element('div', 'pend-head')
  const space = currentSpace()

  const switcher = document.createElement('button')
  switcher.type = 'button'
  switcher.className = 'pend-space'
  switcher.setAttribute('aria-haspopup', 'listbox')
  switcher.setAttribute('aria-expanded', 'false')
  switcher.title = `Cambiar de espacio (${modKey('K')})`
  switcher.append(
    dot('pend-dot', space === null ? 'var(--fg-faint)' : projectColor(space.projectId)),
    element('span', 'pend-space-name', space?.projectName ?? 'Elige un espacio'),
    element('span', 'pend-kbd', modKey('K')),
    icon('chevronDown', 12),
  )
  switcher.addEventListener('click', () => openSwitcher(switcher))

  const search = element('label', 'pend-search')
  const input = document.createElement('input')
  input.type = 'search'
  input.className = 'pend-search-input'
  input.dataset['focus'] = 'search'
  input.value = query
  input.autocomplete = 'off'
  input.spellcheck = false
  const hint = `Buscar en ${space?.projectName ?? 'este espacio'} o saltar a una clave`
  input.placeholder = hint
  input.setAttribute('aria-label', hint)
  input.addEventListener('input', () => {
    query = input.value
    paintBody()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const item = findKey(items ?? [], input.value)
      if (item !== undefined) {
        event.preventDefault()
        jumpTo(item)
      }
    } else if (event.key === 'Escape' && query.length > 0) {
      event.stopPropagation()
      query = ''
      paint()
    }
  })
  search.append(icon('search', 12), input)

  const toggles = element('div', 'pend-layout')
  toggles.setAttribute('role', 'group')
  toggles.setAttribute('aria-label', 'Vista')
  for (const [value, label] of [
    ['list', 'Lista'],
    ['board', 'Tablero'],
  ] as const) {
    const button = textButton('pend-layout-option', label, () => setLayout(value))
    button.setAttribute('aria-pressed', String(layout === value))
    toggles.append(button)
  }

  const count = activeFilters(filters)
  const filter = document.createElement('button')
  filter.type = 'button'
  filter.className = count > 0 ? 'pend-filter pend-filter--on' : 'pend-filter'
  filter.setAttribute('aria-expanded', String(filtersOpen))
  filter.setAttribute('aria-controls', 'pend-filters')
  filter.append(element('span', '', 'Filtros'))
  if (count > 0) filter.append(element('span', 'pend-badge', String(count)))
  filter.addEventListener('click', () => {
    filtersOpen = !filtersOpen
    paint()
  })

  const group = textButton('pend-layout-option pend-grouping', grouping === 'page' ? 'Agrupar: página' : 'Agrupar: estado', () =>
    setGrouping(grouping === 'page' ? 'state' : 'page'),
  )
  group.setAttribute('aria-pressed', String(grouping === 'page'))
  group.disabled = layout === 'board'

  const add = document.createElement('button')
  add.type = 'button'
  add.className = 'pend-new'
  add.disabled = space === null || !available()
  add.append(icon('plus', 12), element('span', '', 'Nuevo'))
  add.addEventListener('click', () => {
    creating = { kind: 'pending', title: '', body: '', pageId: null }
    selectedId = null
    actionFailure = null
    paint()
    host?.querySelector<HTMLInputElement>('.pend-form-title')?.focus()
  })

  bar.append(
    switcher,
    element('span', 'pend-slash', '/'),
    element('h1', 'pend-title', 'Pendientes y hallazgos'),
    element('span', 'pend-spacer'),
    search,
    filter,
    group,
    toggles,
    add,
  )
  return bar
}

function choice<T extends string>(name: string, value: T, options: readonly (readonly [T, string])[], pick: (next: T) => void): HTMLElement {
  const wrap = element('label', 'pend-filter-field')
  const select = document.createElement('select')
  select.className = 'pend-filter-select'
  select.dataset['focus'] = `filter-${name}`
  for (const [optionValue, text] of options) {
    const option = document.createElement('option')
    option.value = optionValue
    option.textContent = text
    option.selected = optionValue === value
    select.append(option)
  }
  select.addEventListener('change', () => pick(select.value as T))
  wrap.append(element('span', 'pend-label', name), select)
  return wrap
}

function filterStrip(): HTMLElement {
  const strip = element('div', 'pend-filters')
  strip.id = 'pend-filters'
  strip.setAttribute('role', 'group')
  strip.setAttribute('aria-label', 'Filtros')
  const status: readonly (readonly [StatusFilter, string])[] = [
    ['all', 'Todos'],
    ['open', 'Abiertos'],
    ['resolved', 'Resueltos'],
  ]
  const kinds: readonly (readonly [Filters['kind'], string])[] = [
    ['all', 'Todos'],
    ['pending', 'Pendientes'],
    ['finding', 'Hallazgos'],
  ]
  const pages: readonly (readonly [string, string])[] = [
    [ALL_PAGES, 'Todas'],
    ...pagesOf(spaceItems()).map((page) => [page.key, page.label] as const),
  ]
  const origins: readonly (readonly ['all' | BacklogOrigin, string])[] = [
    ['all', 'Todos'],
    ['meeting', ORIGIN_LABEL.meeting],
    ['extracted', ORIGIN_LABEL.extracted],
    ['manual', ORIGIN_LABEL.manual],
  ]
  const created: readonly (readonly [CreatedFilter, string])[] = [
    ['any', 'Cuando sea'],
    ['today', 'Hoy'],
    ['week', 'Esta semana'],
    ['old', 'Hace más de 14 días'],
  ]
  strip.append(
    choice('Estado', filters.status, status, (next) => setFilter('status', next)),
    choice('Tipo', filters.kind, kinds, (next) => setFilter('kind', next)),
    choice('Página', filters.page, pages, (next) => setFilter('page', next)),
    choice('Origen', filters.origin, origins, (next) => setFilter('origin', next)),
    choice('Creado', filters.created, created, (next) => setFilter('created', next)),
  )
  if (activeFilters(filters) > 0) {
    strip.append(
      textButton('quiet-link pend-filter-clear', 'Quitar filtros', () => {
        filters = defaultFilters()
        paint()
      }),
    )
  }
  return strip
}

function openSwitcher(anchor: HTMLElement): void {
  toggleSwitcher({ anchor, spaces, active: activeSpace, onPick: switchSpace })
}

function groupLabel(group: IssueGroup): HTMLElement {
  return element('span', `pend-group-label ${STATE_CLASS[group.state]}`, `${group.label} · ${group.items.length}`)
}

function pageLabel(item: BacklogItem): string {
  return item.pageTitle ?? 'Sin página'
}

function listRow(item: BacklogItem, now: Date): HTMLElement {
  const on = item.id === selectedId
  const state = stateOf(item)
  const row = document.createElement('button')
  row.type = 'button'
  row.className = on ? 'pend-row pend-row--on' : 'pend-row'
  row.setAttribute('aria-pressed', String(on))
  row.append(
    dot(`pend-type ${STATE_CLASS[state]}`),
    element('span', 'pend-key', keyOf(item)),
    element('span', state === 'resolved' ? 'pend-row-title pend-done' : 'pend-row-title', item.title),
    element('span', 'pend-row-page', pageLabel(item)),
    element('span', 'pend-row-origin', ORIGIN_LABEL[originOf(item, meetingIds)]),
    element('span', 'pend-age', ageLabel(item.status === 'resolved' ? item.resolvedAt : item.createdAt, now)),
  )
  row.addEventListener('click', () => select(item.id))
  return row
}

function card(item: BacklogItem, now: Date): HTMLElement {
  const on = item.id === selectedId
  const state = stateOf(item)
  const node = document.createElement('button')
  node.type = 'button'
  node.className = on ? 'pend-card pend-card--on' : 'pend-card'
  node.setAttribute('aria-pressed', String(on))
  const meta = element('span', 'pend-card-meta')
  meta.append(
    element('span', 'pend-key', keyOf(item)),
    element('span', 'pend-card-page', pageLabel(item)),
    element('span', 'pend-spacer'),
    element('span', 'pend-age', ageLabel(item.status === 'resolved' ? item.resolvedAt : item.createdAt, now)),
  )
  node.append(element('span', state === 'resolved' ? 'pend-card-title pend-done' : 'pend-card-title', item.title), meta)
  node.addEventListener('click', () => select(item.id))
  return node
}

function emptyNote(): string {
  if (query.trim().length > 0) return `Nada coincide con «${query.trim()}».`
  if (activeFilters(filters) > 0) return 'Nada coincide con los filtros.'
  return 'Este espacio todavía no tiene pendientes ni hallazgos.'
}

function issues(): HTMLElement {
  const section = element('section', 'pend-issues')
  section.setAttribute('aria-label', layout === 'board' ? 'Tablero' : 'Lista')
  if (!available()) {
    section.append(element('p', 'pend-empty', 'El backlog llega con inkwell. Instálalo desde Ajustes para ver pendientes y hallazgos.'))
    return section
  }
  if (failure !== null) {
    const box = element('div', 'problem')
    box.append(element('p', 'problem-message', failure.message))
    if (failure.hint !== null) box.append(element('code', 'problem-hint', failure.hint))
    section.append(box)
  }
  if (items === null) {
    section.append(element('p', 'pend-empty', 'Leyendo el backlog…'))
    return section
  }
  const shown = shownItems()
  if (shown.length === 0) {
    section.append(element('p', 'pend-empty', emptyNote()))
    return section
  }
  const now = new Date()
  const groups = groupIssues(shown)
  if (layout === 'board') {
    const board = element('div', 'pend-board')
    for (const group of groups) {
      const column = element('div', 'pend-column')
      column.append(groupLabel(group))
      for (const item of group.items) column.append(card(item, now))
      board.append(column)
    }
    section.append(board)
    return section
  }
  if (grouping === 'page') {
    for (const group of groupByPage(shown)) {
      const block = element('div', 'pend-group')
      block.append(element('span', 'pend-group-label', `${group.label} · ${group.items.length}`))
      for (const item of group.items) block.append(listRow(item, now))
      section.append(block)
    }
    return section
  }
  for (const group of groups) {
    if (group.items.length === 0) continue
    const block = element('div', 'pend-group')
    block.append(groupLabel(group))
    for (const item of group.items) block.append(listRow(item, now))
    section.append(block)
  }
  return section
}

function label(text: string): HTMLElement {
  return element('span', 'pend-label', text)
}

function copyButton(className: string, text: string, shown: string, title: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  const done = copied === text
  button.title = done ? 'Copiado' : title
  button.setAttribute('aria-label', done ? 'Copiado' : `${title}: ${shown}`)
  button.append(element('span', '', shown), icon(done ? 'check' : 'copy', 12))
  button.addEventListener('click', () => copy(text))
  return button
}

function detail(): HTMLElement {
  const aside = element('aside', 'pend-detail')
  aside.setAttribute('aria-label', 'Detalle')
  if (creating !== null) {
    aside.append(...form(creating))
    return aside
  }
  const item = selectedItem()
  if (item === null) {
    aside.append(element('p', 'pend-empty', 'Elige un pendiente o un hallazgo para ver su detalle.'))
    return aside
  }
  const state = stateOf(item)
  const key = keyOf(item)
  const space = currentSpace()
  const now = new Date()

  const top = element('div', 'pend-detail-top')
  top.append(
    copyButton('pend-detail-key', key, key, 'Copiar la clave'),
    element('span', `pend-detail-type ${STATE_CLASS[state]}`, STATE_LABEL[state]),
  )

  const project = element('span', 'pend-detail-project')
  const since =
    item.status === 'resolved'
      ? `resuelto hace ${ageLabel(item.resolvedAt ?? item.updatedAt, now)}`
      : `abierto hace ${ageLabel(item.createdAt, now)}`
  project.append(
    dot('pend-dot pend-dot--small', projectColor(item.projectId)),
    document.createTextNode(`${item.projectName ?? space?.projectName ?? 'Sin proyecto'} · ${since}`),
  )

  const description = element(
    'p',
    item.body.trim().length > 0 ? 'pend-detail-body' : 'pend-detail-body pend-quiet',
    item.body.trim().length > 0 ? item.body : 'Sin descripción.',
  )

  const page = element('div', 'pend-field pend-field--rule')
  page.append(label('Página'))
  const pageId = item.pageId
  if (pageId === null) page.append(element('span', 'pend-quiet', 'Sin página'))
  else page.append(textButton('quiet-link pend-page-link', pageLabel(item), () => go(pageRoute(pageId, space?.projectSlug ?? null))))

  const origin = element('div', 'pend-field')
  origin.append(label('Origen'), element('span', 'pend-detail-origin', ORIGIN_LABEL[originOf(item, meetingIds)]))

  const ask = element('div', 'pend-field')
  ask.append(label('Pedírselo a Claude'), copyButton('pend-prompt', closePrompt(item), closePrompt(item), 'Copiar'))

  aside.append(top, element('h2', 'pend-detail-title', item.title), project, description, page, origin, ask)

  if (item.status === 'resolved') {
    const how = element('div', 'pend-field')
    const note = item.resolution.trim()
    how.append(label('Cómo se resolvió'), element('span', note.length > 0 ? 'pend-detail-note' : 'pend-detail-note pend-quiet', note.length > 0 ? note : 'Se cerró sin nota.'))
    aside.append(how)
  } else {
    const how = element('label', 'pend-field')
    const area = document.createElement('textarea')
    area.className = 'pend-input pend-textarea'
    area.dataset['focus'] = `resolution-${item.id}`
    area.rows = 2
    area.placeholder = 'Cómo se resolvió (opcional)'
    area.value = resolutions.get(item.id) ?? ''
    area.addEventListener('input', () => resolutions.set(item.id, area.value))
    how.append(label('Resolución'), area)
    aside.append(how)
  }

  const actions = element('div', 'pend-actions')
  const working = busy.has(item.id)
  if (item.status === 'open') {
    const done = textButton('primary-button pend-resolve', 'Resolver', () => resolve(item))
    done.disabled = working
    actions.append(done)
  }
  if (item.status === 'open') {
    const other = otherKind(item.kind)
    const turn = textButton('quiet-link pend-convert', other === 'pending' ? 'Convertir en pendiente' : 'Convertir en hallazgo', () =>
      convert(item, other),
    )
    turn.disabled = working
    actions.append(turn)
  }
  if (item.status === 'resolved') {
    const back = textButton('quiet-link', 'Reabrir', () => reopen(item))
    back.disabled = working
    actions.append(back)
  }
  if (working) actions.append(element('span', 'pend-quiet', 'Guardando…'))
  aside.append(actions)
  if (actionFailure !== null) aside.append(element('p', 'pend-error', actionFailure))
  return aside
}

function form(draft: Draft): HTMLElement[] {
  const heading = element('h2', 'pend-detail-title', 'Nuevo')

  const kinds = element('div', 'pend-layout')
  kinds.setAttribute('role', 'radiogroup')
  kinds.setAttribute('aria-label', 'Tipo')
  for (const [value, text] of [
    ['pending', 'Pendiente'],
    ['finding', 'Hallazgo'],
  ] as const) {
    const option = textButton('pend-layout-option', text, () => {
      draft.kind = value
      paint()
    })
    option.setAttribute('role', 'radio')
    option.setAttribute('aria-checked', String(draft.kind === value))
    option.setAttribute('aria-pressed', String(draft.kind === value))
    kinds.append(option)
  }

  const title = document.createElement('input')
  title.type = 'text'
  title.className = 'pend-input pend-form-title'
  title.dataset['focus'] = 'new-title'
  title.placeholder = 'Título'
  title.setAttribute('aria-label', 'Título')
  title.value = draft.title
  title.addEventListener('input', () => {
    draft.title = title.value
    submit.disabled = saving || draft.title.trim().length === 0
  })
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      void create(draft)
    }
  })

  const body = document.createElement('textarea')
  body.className = 'pend-input pend-textarea'
  body.dataset['focus'] = 'new-body'
  body.rows = 4
  body.placeholder = 'Descripción (opcional)'
  body.setAttribute('aria-label', 'Descripción')
  body.value = draft.body
  body.addEventListener('input', () => {
    draft.body = body.value
  })

  const page = document.createElement('select')
  page.className = 'pend-input'
  page.dataset['focus'] = 'new-page'
  page.setAttribute('aria-label', 'Página')
  const none = document.createElement('option')
  none.value = ''
  none.textContent = 'Sin página'
  page.append(none)
  for (const candidate of spacePages(currentSpace())) {
    const option = document.createElement('option')
    option.value = String(candidate.pageId)
    option.textContent = candidate.title
    option.selected = candidate.pageId === draft.pageId
    page.append(option)
  }
  page.addEventListener('change', () => {
    draft.pageId = page.value === '' ? null : Number(page.value)
  })

  const actions = element('div', 'pend-actions')
  const submit = textButton('primary-button pend-resolve', saving ? 'Guardando…' : 'Crear', () => void create(draft))
  submit.disabled = saving || draft.title.trim().length === 0
  const cancel = textButton('quiet-link', 'Cancelar', () => {
    creating = null
    actionFailure = null
    paint()
  })
  actions.append(submit, cancel)

  const parts: HTMLElement[] = [heading, kinds, title, body, page, actions]
  if (actionFailure !== null) parts.push(element('p', 'pend-error', actionFailure))
  return parts
}

function paintBody(): void {
  if (host === null) return
  const body = host.querySelector<HTMLElement>('.pend-body')
  if (body === null) {
    paint()
    return
  }
  body.replaceChildren(issues(), detail())
}

interface FocusMark {
  key: string
  start: number | null
  end: number | null
}

function focusMark(): FocusMark | null {
  const focused = document.activeElement
  if (!(focused instanceof HTMLElement) || host === null || !host.contains(focused)) return null
  const key = focused.dataset['focus']
  if (key === undefined) return null
  const typed = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement
  let start: number | null = null
  let end: number | null = null
  if (typed) {
    try {
      start = focused.selectionStart
      end = focused.selectionEnd
    } catch {
      start = null
    }
  }
  return { key, start, end }
}

function restoreFocus(root: HTMLElement, mark: FocusMark | null): void {
  if (mark === null) return
  const target = root.querySelector<HTMLElement>(`[data-focus="${mark.key}"]`)
  if (target === null) return
  target.focus()
  if ((target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) && mark.start !== null) {
    try {
      target.setSelectionRange(mark.start, mark.end ?? mark.start)
    } catch {
      return
    }
  }
}

function paint(): void {
  if (host === null) return
  const mark = focusMark()
  const root = element('div', 'pend')
  const body = element('div', 'pend-body')
  body.append(issues(), detail())
  root.append(header())
  if (filtersOpen) root.append(filterStrip())
  root.append(body)
  host.replaceChildren(root)
  shownSignature = signature()
  restoreFocus(root, mark)
}

function keys(event: KeyboardEvent): void {
  if (!visible() || host === null) return
  if (isSpaceShortcut(event)) {
    event.preventDefault()
    const anchor = host.querySelector<HTMLElement>('.pend-space')
    if (anchor !== null) openSwitcher(anchor)
    return
  }
  if (isSwitcherOpen()) return
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    const input = host.querySelector<HTMLInputElement>('.pend-search-input')
    input?.focus()
    input?.select()
  }
}

function listenOnce(): void {
  if (listening) return
  listening = true
  window.addEventListener('keydown', keys)
}

export function receive(event: ShellEvent): void {
  if (!alive) return
  if (event.type === 'docs-changed' || event.type === 'visible') {
    void load()
  } else if (event.type === 'tools') {
    modules = event.tools.modules
    void load()
  }
}

export async function mount(target: HTMLElement, path: readonly string[]): Promise<void> {
  host = target
  alive = true
  listenOnce()
  stopSpaceWatch = onSpaceChange((slug) => {
    if (slug !== activeSpace) switchSpace(slug)
  })
  applyTarget(parsePendientesPath(path))
  paint()
  await load()
}

export function update(path: readonly string[]): void {
  applyTarget(parsePendientesPath(path))
  void load()
}

export function unmount(): void {
  alive = false
  closeSwitcher()
  stopSpaceWatch?.()
  stopSpaceWatch = null
  host = null
  shownSignature = null
}
