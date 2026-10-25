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
import { pageRoute } from '../docs/route.ts'
import {
  ageLabel,
  closePrompt,
  findKey,
  groupIssues,
  inSpace,
  keyOf,
  matches,
  STATE_LABEL,
  stateOf,
  type IssueGroup,
  type IssueState,
} from './model.ts'
import type { ShellEvent } from '../section.ts'
import { parsePendientesPath, pendientesRoute, type PendientesTarget } from './route.ts'
import './pendientes.css'

type Layout = 'list' | 'board'

interface Draft {
  kind: BacklogKind
  title: string
  body: string
  pageId: number | null
}

const LAYOUT_KEY = 'den.pendientes.layout'
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
let selectedId: number | null = null
let query = ''
let layout: Layout = rememberedLayout()
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
  return spaceItems().filter((item) => matches(item, query))
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
  if (slug === activeSpace) return
  activeSpace = slug
  rememberSpace(slug)
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
  select(item.id)
}

function applyTarget(target: PendientesTarget): void {
  if (items === null || spaces.length === 0) {
    if (target.space !== null) activeSpace = target.space
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

async function load(): Promise<void> {
  try {
    modules = (await toolsStatus()).modules
  } catch {
    modules = null
  }
  if (!available()) {
    items = []
    paint()
    return
  }
  const [tree, list] = await Promise.allSettled([notesTree(), backlogList()])
  if (tree.status === 'fulfilled') spaces = tree.value.data.spaces ?? []
  if (list.status === 'fulfilled') {
    items = list.value.data
    failure = null
  } else {
    failure = describeProblem(list.reason)
    items = items ?? []
  }
  if (tree.status === 'rejected' && failure === null) failure = describeProblem(tree.reason)
  chooseDefaultSpace()
  if (pendingKey !== null) {
    const key = pendingKey
    pendingKey = null
    const item = findKey(items, key)
    if (item !== undefined) jumpTo(item)
  }
  if (selectedId !== null && selectedItem() === null) selectedId = null
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
    toggles,
    add,
  )
  return bar
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

  const ask = element('div', 'pend-field')
  ask.append(label('Pedírselo a Claude'), copyButton('pend-prompt', closePrompt(item), closePrompt(item), 'Copiar'))

  aside.append(top, element('h2', 'pend-detail-title', item.title), project, description, page, ask)

  if (item.status === 'resolved') {
    const how = element('div', 'pend-field')
    const note = item.resolution.trim()
    how.append(label('Cómo se resolvió'), element('span', note.length > 0 ? 'pend-detail-note' : 'pend-detail-note pend-quiet', note.length > 0 ? note : 'Se cerró sin nota.'))
    aside.append(how)
  } else {
    const how = element('label', 'pend-field')
    const area = document.createElement('textarea')
    area.className = 'pend-input pend-textarea'
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
  if (item.status === 'open' && item.kind === 'finding') {
    const turn = textButton('quiet-link', 'Convertir en pendiente', () => convert(item, 'pending'))
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
  body.rows = 4
  body.placeholder = 'Descripción (opcional)'
  body.setAttribute('aria-label', 'Descripción')
  body.value = draft.body
  body.addEventListener('input', () => {
    draft.body = body.value
  })

  const page = document.createElement('select')
  page.className = 'pend-input'
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

function paint(): void {
  if (host === null) return
  const focused = document.activeElement
  const keepSearch = focused instanceof HTMLInputElement && focused.classList.contains('pend-search-input')
  const caret = keepSearch ? focused.selectionStart : null
  const root = element('div', 'pend')
  const body = element('div', 'pend-body')
  body.append(issues(), detail())
  root.append(header(), body)
  host.replaceChildren(root)
  if (keepSearch) {
    const input = root.querySelector<HTMLInputElement>('.pend-search-input')
    input?.focus()
    if (input !== null && caret !== null) input.setSelectionRange(caret, caret)
  }
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
  if (event.type === 'docs-changed') {
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
}
