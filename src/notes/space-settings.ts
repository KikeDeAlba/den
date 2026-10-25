import './space-settings.css'
import {
  atlassianSites,
  confluenceResolve,
  confluenceSync,
  confluenceSyncStatus,
  describeProblem,
  projectAtlassian,
  type AtlassianSite,
  type PageNode,
  type Problem,
  type Space,
  type SpaceAtlassian,
  type SyncMapping,
  type SyncResult,
} from '../bita.ts'
import { element, icon } from '../dom.ts'
import { projectColor } from '../shell/colors.ts'
import { button } from './media-dialogs.ts'

export interface SpaceSettingsContext {
  space: Space
  clientName: string | null
  jiraKey: string | null
  railOpen: boolean
  onExpandRail: () => void
  onManageConnections: () => void
  onSaved: () => void
  available: { atlassian: boolean; meetings: boolean }
}

type SettingsTab = 'general' | 'atlassian' | 'meetings'
type RefKind = 'space' | 'page'

interface Draft {
  site: string
  refKind: RefKind
  url: string
  pull: boolean
  push: boolean
}

interface Reference {
  ok: boolean
  label: string
}

const TABS: { key: SettingsTab; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'atlassian', label: 'Confluence y Jira' },
  { key: 'meetings', label: 'Reuniones' },
]

let tab: SettingsTab = 'atlassian'
let slug: string | null = null
let draft: Draft | null = null
let baseline = ''
let sites: AtlassianSite[] | null = null
let sitesFailure: Problem | null = null
let mappings: SyncMapping[] | null = null
let mappingsFailure: Problem | null = null
let saveFailure: Problem | null = null
let syncFailure: Problem | null = null
let saving = false
let syncing = false
let savedAt = 0
let lastResult: SyncResult | null = null
const resolving = new Set<number>()
let host: HTMLElement | null = null
let context: SpaceSettingsContext | null = null
let root: HTMLElement | null = null

function draftOf(atlassian: SpaceAtlassian | null | undefined): Draft {
  return {
    site: atlassian?.site ?? '',
    refKind: atlassian?.confluence?.kind ?? 'page',
    url: atlassian?.confluence?.url ?? atlassian?.confluence?.spaceKey ?? '',
    pull: atlassian?.sync.pull ?? false,
    push: atlassian?.sync.push ?? false,
  }
}

function signature(value: Draft | null): string {
  return JSON.stringify(value)
}

export function renderSpaceSettings(target: HTMLElement, next: SpaceSettingsContext): void {
  const entering = !(host === target && mounted())
  host = target
  context = next
  const nextDraft = draftOf(next.space.atlassian)
  if (slug !== next.space.projectSlug) {
    slug = next.space.projectSlug
    draft = nextDraft
    baseline = signature(nextDraft)
    mappings = null
    mappingsFailure = null
    saveFailure = null
    syncFailure = null
    lastResult = null
    if (next.available.atlassian) void loadMappings()
  } else if (signature(nextDraft) !== baseline) {
    const dirty = signature(draft) !== baseline
    baseline = signature(nextDraft)
    if (!dirty) draft = nextDraft
  }
  if (next.available.atlassian && (entering || (sites === null && sitesFailure === null))) void loadSites()
  paint(true)
}

function mounted(): boolean {
  return host !== null && root !== null && root.isConnected && root.parentElement === host
}

function paint(force: boolean): void {
  if (host === null || context === null) return
  if (!force && !mounted()) return
  const scroller = root?.querySelector<HTMLElement>('.ss-scroll')
  const scrollTop = mounted() && scroller ? scroller.scrollTop : 0
  const focused = document.activeElement instanceof HTMLInputElement ? document.activeElement : null
  const focusId = focused !== null && host.contains(focused) ? focused.id : ''
  const caret = focused?.selectionStart ?? null
  root = build(context)
  host.replaceChildren(root)
  const fresh = root.querySelector<HTMLElement>('.ss-scroll')
  if (fresh) fresh.scrollTop = scrollTop
  if (focusId.length > 0) {
    const input = root.querySelector<HTMLInputElement>(`#${CSS.escape(focusId)}`)
    if (input) {
      input.focus()
      if (caret !== null) input.setSelectionRange(caret, caret)
    }
  }
}

async function loadSites(): Promise<void> {
  try {
    sites = await atlassianSites(false)
    sitesFailure = null
  } catch (error) {
    sites = []
    sitesFailure = describeProblem(error)
  }
  paint(false)
}

async function loadMappings(): Promise<void> {
  const wanted = slug
  if (wanted === null) return
  try {
    const found = await confluenceSyncStatus(wanted)
    if (slug !== wanted) return
    mappings = found
    mappingsFailure = null
  } catch (error) {
    if (slug !== wanted) return
    mappings = []
    mappingsFailure = describeProblem(error)
  }
  paint(false)
}

function build(current: SpaceSettingsContext): HTMLElement {
  const wrap = element('div', 'ss-root')
  wrap.append(bar(current))
  const scroll = element('div', 'ss-scroll')
  const head = element('div', 'ss-head')
  const dot = element('span', 'ss-dot')
  dot.style.background = projectColor(current.space.projectId)
  head.append(dot, element('h1', 'ss-title', current.space.projectName ?? 'Sin proyecto'), element('span', 'v2-kbd', 'ajustes del espacio'))
  const allowed = TABS.filter((item) => item.key === 'general' || current.available[item.key])
  if (!allowed.some((item) => item.key === tab)) tab = 'general'
  scroll.append(head, tabs(allowed))
  const body = element('div', 'ss-body')
  if (tab === 'general') body.append(...general(current))
  else if (tab === 'meetings') body.append(...meetings(current))
  else body.append(...atlassian(current))
  scroll.append(body)
  wrap.append(scroll)
  if (tab === 'atlassian' && draft !== null && signature(draft) !== baseline) wrap.append(saveBar())
  return wrap
}

function bar(current: SpaceSettingsContext): HTMLElement {
  const row = element('div', 'reader-bar ss-bar')
  if (!current.railOpen) {
    const unfold = document.createElement('button')
    unfold.type = 'button'
    unfold.className = 'icon-button reader-step'
    unfold.setAttribute('aria-label', 'Desplegar el árbol')
    unfold.append(icon('panelLeft', 14))
    unfold.addEventListener('click', current.onExpandRail)
    row.append(unfold)
  }
  const crumb = element('nav', 'reader-crumb')
  crumb.append(element('span', 'crumb-space', current.space.projectName ?? 'Sin proyecto'), element('span', 'crumb-sep', '/'), element('span', 'crumb-here', 'Ajustes del espacio'))
  row.append(crumb)
  return row
}

function tabs(allowed: { key: SettingsTab; label: string }[]): HTMLElement {
  const list = element('div', 'ss-tabs')
  list.setAttribute('role', 'tablist')
  list.setAttribute('aria-label', 'Secciones de ajustes')
  for (const item of allowed) {
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'ss-tab'
    trigger.setAttribute('role', 'tab')
    trigger.setAttribute('aria-selected', String(item.key === tab))
    trigger.textContent = item.label
    trigger.addEventListener('click', () => {
      tab = item.key
      paint(false)
    })
    list.append(trigger)
  }
  return list
}

function card(titleText: string, id: string, extra: HTMLElement[] = []): { section: HTMLElement; headRow: HTMLElement } {
  const section = element('section', 'ss-card')
  section.setAttribute('aria-labelledby', id)
  const headRow = element('div', 'ss-card-head')
  const title = element('h2', 'ss-card-title', titleText)
  title.id = id
  headRow.append(title, ...extra)
  section.append(headRow)
  return { section, headRow }
}

function fact(label: string, value: string): HTMLElement {
  const row = element('div', 'ss-fact')
  row.append(element('span', 'v2-kbd', label), element('span', 'ss-fact-value', value))
  return row
}

function general(current: SpaceSettingsContext): HTMLElement[] {
  const { section } = card('Proyecto', 'ss-general')
  const grid = element('div', 'ss-facts')
  grid.append(
    fact('Nombre', current.space.projectName ?? 'Sin proyecto'),
    fact('Cliente', current.clientName ?? 'Sin cliente'),
    fact('Proyecto de Jira', current.jiraKey ?? 'Sin Jira'),
    fact('Páginas', String(current.space.pageCount)),
    fact('Entradas medidas', String(current.space.entryCount)),
    fact('Carpeta', current.space.projectSlug),
  )
  section.append(grid, element('p', 'ss-note', 'El nombre del espacio se cambia con inkwell; el proyecto de Jira, con tally. Las dos cosas, desde Claude o la terminal.'))
  return [section]
}

function meetingCount(pages: PageNode[]): { total: number; remote: number } {
  let total = 0
  let remote = 0
  const walk = (list: PageNode[]): void => {
    for (const page of list) {
      for (const meeting of page.meetings ?? []) {
        total += 1
        if (meeting.kind === 'remote-meeting') remote += 1
      }
      walk(page.children ?? [])
    }
  }
  walk(pages)
  return { total, remote }
}

function meetings(current: SpaceSettingsContext): HTMLElement[] {
  const counts = meetingCount(current.space.pages)
  const { section } = card('Reuniones grabadas', 'ss-meetings')
  const grid = element('div', 'ss-facts')
  grid.append(
    fact('Reuniones con página', String(counts.total)),
    fact('Remotas', String(counts.remote)),
    fact('Presenciales', String(counts.total - counts.remote)),
  )
  section.append(
    grid,
    element('p', 'ss-note', 'Las reuniones se graban con recap y se ligan a una entrada del cronómetro; la página que sale de esa entrada muestra la minuta, la transcripción y la grabación.'),
  )
  return [section]
}

export function parseReference(value: string, kind: RefKind): Reference | null {
  const text = value.trim()
  if (text.length === 0) return null
  if (/^~?[A-Za-z0-9_-]+$/.test(text) && !text.includes('://')) {
    return kind === 'space' ? { ok: true, label: `espacio ${text.toUpperCase()}` } : { ok: false, label: 'Una página raíz necesita la URL completa de la página.' }
  }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { ok: false, label: 'No reconozco esa URL de Confluence.' }
  }
  const page = /\/wiki\/spaces\/([^/]+)\/pages\/(\d+)/.exec(url.pathname)
  if (page !== null) {
    const label = `página ${page[2] ?? ''} · espacio ${decodeURIComponent(page[1] ?? '')}`
    return kind === 'page' ? { ok: true, label } : { ok: true, label: `${label} · se toma su espacio` }
  }
  const space = /\/wiki\/spaces\/([^/]+)/.exec(url.pathname)
  if (space !== null) {
    const label = `espacio ${decodeURIComponent(space[1] ?? '')}`
    return kind === 'space' ? { ok: true, label } : { ok: false, label: `Esa URL es del ${label}; falta la página.` }
  }
  const viewPage = /pageId=(\d+)/.exec(url.search)
  if (viewPage !== null) return { ok: true, label: `página ${viewPage[1] ?? ''}` }
  return { ok: false, label: 'No reconozco esa URL de Confluence.' }
}

function relative(iso: string | null): string {
  if (iso === null) return 'nunca'
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return iso
  const minutes = Math.max(0, Math.floor((Date.now() - then) / 60_000))
  if (minutes < 1) return 'hace un momento'
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'ayer' : `hace ${days} días`
}

function segmented<T extends string>(label: string, options: { value: T; label: string }[], value: T, onPick: (value: T) => void): HTMLElement {
  const group = element('div', 'ss-seg')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', label)
  for (const option of options) {
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.setAttribute('aria-pressed', String(option.value === value))
    trigger.textContent = option.label
    trigger.addEventListener('click', () => onPick(option.value))
    group.append(trigger)
  }
  return group
}

function labelled(text: string, control: HTMLElement, grow = false): HTMLElement {
  const wrap = element('div', grow ? 'ss-labelled ss-labelled--grow' : 'ss-labelled')
  wrap.append(element('span', 'v2-kbd', text), control)
  return wrap
}

function problemLine(problem: Problem): HTMLElement {
  const box = element('div', 'ss-problem')
  box.append(icon('warning', 13))
  const text = element('div', 'ss-problem-text')
  text.append(element('span', '', problem.message))
  if (problem.hint) text.append(element('span', 'ss-problem-hint', problem.hint))
  box.append(text)
  return box
}

function siteStatusColor(site: AtlassianSite | undefined): string {
  if (site === undefined) return 'var(--elev-strong)'
  if (site.status === 'ok') return 'var(--ok)'
  if (site.status === 'auth_failed' || site.status === 'unreachable') return 'var(--estimate)'
  return site.tokenStored ? 'var(--ok)' : 'var(--elev-strong)'
}

function connectionCard(current: SpaceSettingsContext, value: Draft): HTMLElement {
  const manage = button('Administrar conexiones', 'v2-btn', current.onManageConnections)
  const { section } = card('Conexión Atlassian', 'ss-conn', [manage])
  const row = element('div', 'ss-row')

  const field = element('label', 'ss-field ss-select')
  const known = sites ?? []
  const chosen = known.find((site) => site.site === value.site)
  const dot = element('span', 'ss-status-dot')
  dot.style.background = siteStatusColor(chosen)
  const select = document.createElement('select')
  select.id = 'ss-site'
  select.setAttribute('aria-label', 'Sitio')
  const none = document.createElement('option')
  none.value = ''
  none.textContent = sites === null ? 'Leyendo sitios…' : 'Sin sitio'
  select.append(none)
  const names = known.map((site) => site.site)
  if (value.site.length > 0 && !names.includes(value.site)) names.unshift(value.site)
  for (const name of names) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name.replace(/^https?:\/\//, '')
    select.append(option)
  }
  select.value = value.site
  select.addEventListener('change', () => {
    value.site = select.value
    paint(false)
  })
  field.append(dot, select, icon('chevronDown', 12))
  row.append(labelled('Sitio', field, true))

  section.append(row)
  if (sitesFailure !== null) section.append(problemLine(sitesFailure))
  else if (sites !== null && sites.length === 0) {
    section.append(element('p', 'ss-note', 'Todavía no hay organizaciones guardadas en atl. Agrégalas en «Administrar conexiones».'))
  }
  if (chosen?.status === 'auth_failed') {
    section.append(problemLine({ kind: 'cli-failed', message: 'El token guardado para este sitio ya no sirve.', hint: 'Renuévalo en «Administrar conexiones».' }))
  }
  return section
}

function documentationCard(current: SpaceSettingsContext, value: Draft): HTMLElement {
  const { section } = card('Documentación en Confluence', 'ss-doc')
  const row = element('div', 'ss-row')
  row.append(
    labelled(
      'Apunta a',
      segmented<RefKind>(
        'Tipo de referencia',
        [
          { value: 'space', label: 'Un espacio' },
          { value: 'page', label: 'Una página raíz' },
        ],
        value.refKind,
        (kind) => {
          value.refKind = kind
          paint(false)
        },
      ),
    ),
  )
  const field = element('label', 'ss-field')
  field.append(icon('link', 12))
  const input = document.createElement('input')
  input.id = 'ss-url'
  input.type = 'text'
  input.spellcheck = false
  input.autocomplete = 'off'
  input.placeholder = value.refKind === 'space' ? 'https://empresa.atlassian.net/wiki/spaces/CLAVE o CLAVE' : 'https://empresa.atlassian.net/wiki/spaces/CLAVE/pages/123'
  input.value = value.url
  input.setAttribute('aria-label', value.refKind === 'space' ? 'URL o clave del espacio' : 'URL de la página raíz')
  input.addEventListener('input', () => {
    value.url = input.value
    paint(false)
  })
  field.append(input)
  row.append(labelled(value.refKind === 'space' ? 'URL o clave del espacio' : 'URL de la página', field, true))
  section.append(row)

  const status = element('div', 'ss-ref')
  const parsed = parseReference(value.url, value.refKind)
  const saved = current.space.atlassian?.confluence ?? null
  if (parsed === null) {
    status.append(element('span', 'ss-pill', 'Sin documentación oficial en Confluence'))
  } else if (parsed.ok) {
    const pill = element('span', 'ss-pill ss-pill--ok')
    const same = saved !== null && (saved.url === value.url.trim() || saved.spaceKey === value.url.trim())
    const title = same && saved?.title ? `${saved.title} · ` : ''
    pill.append(icon('check', 11), element('span', '', `${title}${parsed.label}`))
    status.append(pill)
  } else {
    const pill = element('span', 'ss-pill ss-pill--warn')
    pill.append(icon('warning', 11), element('span', '', parsed.label))
    status.append(pill)
  }
  if (current.jiraKey !== null) status.append(element('span', 'v2-kbd', `Jira: proyecto ${current.jiraKey}`))
  section.append(status)
  section.append(
    element(
      'p',
      'ss-note',
      `Claude toma ${value.refKind === 'space' ? 'este espacio' : 'esta página'} como la documentación oficial de ${current.space.projectName ?? 'este proyecto'} al planear, documentar y registrar tiempo.`,
    ),
  )
  return section
}

function toggle(id: string, title: string, note: string, on: boolean, onChange: (value: boolean) => void): HTMLElement {
  const wrap = element('label', 'ss-toggle')
  wrap.setAttribute('for', id)
  const control = document.createElement('button')
  control.type = 'button'
  control.id = id
  control.className = on ? 'ss-switch ss-switch--on' : 'ss-switch'
  control.setAttribute('role', 'switch')
  control.setAttribute('aria-checked', String(on))
  control.addEventListener('click', (event) => {
    event.preventDefault()
    onChange(!on)
  })
  const text = element('span', 'ss-toggle-text')
  text.append(element('span', 'ss-toggle-title', title), element('span', 'ss-toggle-note', note))
  wrap.append(control, text)
  return wrap
}

function arrow(direction: string): string {
  if (direction === 'both' || direction === 'sync') return '⇄'
  if (direction === 'push') return '→'
  if (direction === 'pull') return '←'
  return '·'
}

function syncSummary(result: SyncResult): string {
  const parts: string[] = []
  if (result.pulled.length > 0) parts.push(`${result.pulled.length} traídas`)
  if (result.pushed.length > 0) parts.push(`${result.pushed.length} publicadas`)
  if (result.created.length > 0) parts.push(`${result.created.length} nuevas`)
  if (result.conflicts.length > 0) parts.push(`${result.conflicts.length} en conflicto`)
  return parts.length === 0 ? 'Todo estaba al día.' : `${parts.join(' · ')}.`
}

function syncCard(current: SpaceSettingsContext, value: Draft): HTMLElement {
  const sync = current.space.atlassian?.sync ?? null
  const conflicts = (mappings ?? []).filter((mapping) => mapping.state === 'conflict')
  const now = document.createElement('button')
  now.type = 'button'
  now.className = 'v2-btn'
  now.disabled = syncing || signature(draft) !== baseline
  now.title = signature(draft) !== baseline ? 'Guarda los cambios antes de sincronizar' : ''
  now.append(icon('refresh', 12), document.createTextNode(syncing ? 'Sincronizando…' : 'Sincronizar ahora'))
  now.addEventListener('click', () => {
    void runSync()
  })
  const { section } = card('Sincronización automática', 'ss-sync', [
    element('span', 'v2-kbd', `última: ${relative(sync?.lastSyncAt ?? null)}${mappings !== null ? ` · ${mappings.length} ${mappings.length === 1 ? 'página' : 'páginas'}` : ''}`),
    now,
  ])

  const toggles = element('div', 'ss-toggles')
  toggles.append(
    toggle('ss-pull', 'Confluence → inkwell', 'Trae a inkwell lo que cambie en Confluence. Apágalo y las páginas siguen creciendo como tus notas locales.', value.pull, (on) => {
      value.pull = on
      paint(false)
    }),
    toggle('ss-push', 'inkwell → Confluence', 'Publica en Confluence lo que agregues en inkwell. Apágalo y Confluence se queda como está.', value.push, (on) => {
      value.push = on
      paint(false)
    }),
  )
  section.append(toggles)

  if (value.pull && value.push) {
    const warn = element('div', 'ss-warning')
    warn.append(icon('warning', 14), element('span', 'ss-warning-text', 'Con los dos sentidos prendidos, si una página cambia en ambos lados no se pisa: queda en conflicto hasta que elijas.'))
    if (conflicts.length > 0) {
      warn.append(
        button(`${conflicts.length} ${conflicts.length === 1 ? 'conflicto' : 'conflictos'}`, 'v2-btn', () => {
          root?.querySelector<HTMLElement>('.ss-map-row--conflict')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }),
      )
    }
    section.append(warn)
  }

  if (value.site.length === 0 && (value.pull || value.push)) {
    section.append(problemLine({ kind: 'cli-failed', message: 'Para sincronizar hace falta elegir un sitio de Atlassian.', hint: null }))
  }
  if (lastResult !== null) section.append(element('p', 'ss-note ss-note--ok', syncSummary(lastResult)))
  if (syncFailure !== null) section.append(problemLine(syncFailure))
  section.append(mappingTable())
  return section
}

function mappingTable(): HTMLElement {
  const list = element('div', 'ss-map')
  const head = element('div', 'ss-map-row ss-map-row--head')
  head.append(element('span', 'v2-kbd', 'En inkwell'), element('span'), element('span', 'v2-kbd', 'En Confluence'), element('span', 'v2-kbd', 'Estado'))
  list.append(head)
  if (mappingsFailure !== null) {
    list.append(problemLine(mappingsFailure))
    return list
  }
  if (mappings === null) {
    list.append(element('p', 'ss-note', 'Leyendo qué páginas están ligadas…'))
    return list
  }
  if (mappings.length === 0) {
    list.append(element('p', 'ss-note', 'Ninguna página está ligada a Confluence todavía.'))
    return list
  }
  for (const mapping of mappings) {
    const conflict = mapping.state === 'conflict'
    const row = element('div', conflict ? 'ss-map-row ss-map-row--conflict' : 'ss-map-row')
    row.append(
      element('span', 'ss-map-local', mapping.title),
      element('span', 'ss-map-arrow', arrow(mapping.direction)),
      element('span', 'ss-map-remote', mapping.confluenceTitle),
    )
    const state = element('span', conflict ? 'ss-map-state ss-map-state--conflict' : 'ss-map-state', conflict ? 'conflicto' : 'al día')
    row.append(state)
    list.append(row)
    if (conflict) {
      const actions = element('div', 'ss-map-actions')
      const busy = resolving.has(mapping.pageId)
      const local = button('Quedarme con inkwell', 'v2-btn', () => void resolve(mapping.pageId, 'local'))
      const remote = button('Usar Confluence', 'v2-btn', () => void resolve(mapping.pageId, 'remote'))
      local.disabled = busy
      remote.disabled = busy
      actions.append(element('span', 'v2-kbd', 'Cambió en los dos lados.'), local, remote)
      list.append(actions)
    }
  }
  return list
}

function atlassian(current: SpaceSettingsContext): HTMLElement[] {
  if (draft === null) draft = draftOf(current.space.atlassian)
  const value = draft
  const nodes = [connectionCard(current, value), documentationCard(current, value), syncCard(current, value)]
  if (saveFailure !== null) nodes.unshift(problemLine(saveFailure))
  if (savedAt > 0 && Date.now() - savedAt < 4000 && signature(draft) === baseline) nodes.unshift(element('p', 'ss-note ss-note--ok', 'Ajustes guardados.'))
  return nodes
}

function saveBar(): HTMLElement {
  const row = element('div', 'ss-savebar')
  row.append(element('span', 'ss-savebar-text', 'Hay cambios sin guardar'), element('span', 'spacer'))
  const discard = button('Descartar', 'v2-btn', () => {
    draft = JSON.parse(baseline) as Draft
    saveFailure = null
    paint(false)
  })
  const save = button(saving ? 'Guardando…' : 'Guardar', 'v2-btn v2-btn--primary', () => void saveDraft())
  discard.disabled = saving
  save.disabled = saving
  row.append(discard, save)
  return row
}

async function saveDraft(): Promise<void> {
  if (draft === null || slug === null || context === null) return
  const parsed = parseReference(draft.url, draft.refKind)
  if (parsed !== null && !parsed.ok) {
    saveFailure = { kind: 'cli-failed', message: parsed.label, hint: null }
    paint(false)
    return
  }
  saving = true
  saveFailure = null
  paint(false)
  try {
    await projectAtlassian(slug, {
      site: draft.site.length > 0 ? draft.site : null,
      confluence: draft.url.trim().length > 0 ? draft.url.trim() : 'none',
      pull: draft.pull,
      push: draft.push,
    })
    baseline = signature(draft)
    savedAt = Date.now()
    context.onSaved()
    void loadMappings()
  } catch (error) {
    saveFailure = describeProblem(error)
  }
  saving = false
  paint(false)
}

async function runSync(): Promise<void> {
  if (slug === null || context === null) return
  syncing = true
  syncFailure = null
  lastResult = null
  paint(false)
  try {
    const results = await confluenceSync(slug)
    lastResult = results.find((result) => result.project === slug) ?? results[0] ?? null
    context.onSaved()
  } catch (error) {
    syncFailure = describeProblem(error)
  }
  syncing = false
  await loadMappings()
}

async function resolve(pageId: number, keep: 'local' | 'remote'): Promise<void> {
  resolving.add(pageId)
  paint(false)
  try {
    await confluenceResolve(pageId, keep)
    syncFailure = null
  } catch (error) {
    syncFailure = describeProblem(error)
  }
  resolving.delete(pageId)
  await loadMappings()
  context?.onSaved()
}
