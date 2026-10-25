import { notesTree, recapList, toolsStatus, type MeetingRecord, type ToolsStatus } from '../../bita.ts'
import { element, icon } from '../../dom.ts'
import { go } from '../../shell/routes.ts'
import type { ShellEvent } from '../section.ts'
import { createLiveView, type LiveMeetingView } from './live.ts'
import {
  ALL_PROJECTS,
  LIVE_ID,
  SUMMARY_CAPABILITY,
  TRANSCRIPT_CAPABILITY,
  groupMeetings,
  hasCapability,
  meetingRoute,
  meetingRows,
  parseMeetingRoute,
  placeIndex,
  projectsOf,
  rowMeta,
  type MeetingRoute,
  type MeetingRow,
  type Place,
} from './model.ts'
import { createPastView, type PastView } from './past.ts'
import './reuniones.css'

let root: HTMLElement | null = null
let nav: HTMLElement | null = null
let detail: HTMLElement | null = null
let live: LiveMeetingView | null = null
let past: { id: string; view: PastView } | null = null
let records: MeetingRecord[] = []
let places = new Map<number, Place>()
let tools: ToolsStatus | null = null
let project = ALL_PROJECTS
let route: MeetingRoute = { id: null, tab: 'minuta' }
let loadToken = 0
let problem: string | null = null

function liveSummary(): Parameters<typeof meetingRows>[2] {
  const view = live?.session.view
  const active = view?.active ?? null
  if (view === undefined || active === null) return null
  return {
    meetingId: active.meetingId,
    title: view.title,
    project: view.project,
    startedAt: active.startedAt,
    entryId: view.entryId,
    mode: active.mode,
  }
}

function rows(): MeetingRow[] {
  return meetingRows(records, places, liveSummary())
}

function selectedId(all: MeetingRow[]): string | null {
  if (route.id !== null) return route.id
  return all.find((row) => row.live)?.id ?? all.filter((row) => !row.live).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]?.id ?? null
}

function projectPicker(all: MeetingRow[]): HTMLElement {
  const field = element('label', 'rm-project')
  const select = document.createElement('select')
  select.setAttribute('aria-label', 'Filtrar por proyecto')
  const options = [{ value: ALL_PROJECTS, text: 'Todos los proyectos' }, ...projectsOf(all).map((name) => ({ value: name, text: name }))]
  for (const option of options) {
    const node = document.createElement('option')
    node.value = option.value
    node.textContent = option.text
    node.selected = option.value === project
    select.append(node)
  }
  select.addEventListener('change', () => {
    project = select.value
    paintNav()
  })
  field.append(select, icon('chevronDown', 11))
  return field
}

function paintNav(): void {
  if (nav === null) return
  const all = rows()
  const chosen = selectedId(all)
  const now = new Date()
  const children: HTMLElement[] = [projectPicker(all)]
  const groups = groupMeetings(all, project, now)
  if (groups.length === 0) {
    children.push(element('p', 'rm-empty', problem ?? (records.length === 0 ? 'Todavía no hay reuniones grabadas.' : 'Ninguna reunión de este proyecto.')))
  }
  for (const group of groups) {
    children.push(element('span', 'rm-group', group.label))
    for (const row of group.rows) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = row.id === chosen ? 'rm-row rm-row--on' : 'rm-row'
      button.setAttribute('aria-pressed', String(row.id === chosen))
      const title = element('span', 'rm-row-title')
      if (row.live) title.append(element('span', 'rec-dot'))
      title.append(row.title)
      button.append(title, element('span', 'rm-row-meta', rowMeta(row, now)))
      button.addEventListener('click', () => go(meetingRoute(row.id)))
      children.push(button)
    }
  }
  nav.replaceChildren(...children)
}

function showDetail(): void {
  if (detail === null || live === null) return
  const all = rows()
  const id = selectedId(all)
  if (id === LIVE_ID || (id === null && live.session.view.active === null && records.length === 0)) {
    past?.view.dispose()
    past = null
    if (live.root.parentElement !== detail) detail.replaceChildren(live.root)
    live.shown()
    return
  }
  const row = all.find((candidate) => candidate.id === id)
  if (row === undefined) {
    past?.view.dispose()
    past = null
    detail.replaceChildren(element('p', 'rm-empty rm-empty--detail', records.length === 0 ? 'Leyendo las reuniones…' : 'No encuentro esa reunión.'))
    return
  }
  if (past !== null && past.id === row.id) {
    past.view.tab(route.tab)
    return
  }
  past?.view.dispose()
  const view = createPastView({
    row,
    tab: route.tab,
    summaryJson: hasCapability(tools, SUMMARY_CAPABILITY),
    transcriptJson: hasCapability(tools, TRANSCRIPT_CAPABILITY),
  })
  past = { id: row.id, view }
  detail.replaceChildren(view.root)
}

function paint(): void {
  paintNav()
  showDetail()
}

async function load(): Promise<void> {
  const token = ++loadToken
  const [list, tree, status] = await Promise.all([
    recapList().catch((error: unknown) => error),
    notesTree().catch(() => null),
    toolsStatus().catch(() => null),
  ])
  if (token !== loadToken) return
  if (Array.isArray(list)) {
    records = list as MeetingRecord[]
    problem = null
  } else {
    problem = 'No pude leer las reuniones de recap.'
  }
  places = placeIndex(tree?.data.spaces)
  tools = status
  paint()
}

export function mount(host: HTMLElement, path: readonly string[]): void {
  route = parseMeetingRoute(path)
  root = element('div', 'rm')
  nav = element('nav', 'rm-nav')
  nav.setAttribute('aria-label', 'Reuniones')
  detail = element('div', 'rm-detail')
  root.append(nav, detail)
  host.replaceChildren(root)
  let lastLive: string | null = null
  live = createLiveView({
    changed: () => {
      const id = live?.session.view.active?.meetingId ?? null
      if (id === lastLive) return
      lastLive = id
      if (id === null) void load()
      else paint()
    },
    fullscreen: (on) => root?.classList.toggle('rm--full', on),
  })
  live.start()
  paint()
  void load()
}

export function receive(event: ShellEvent): void {
  if (event.type === 'meeting-media') void load()
  else if (event.type === 'tools') tools = event.tools
  else live?.receive(event)
}

export function update(path: readonly string[]): void {
  route = parseMeetingRoute(path)
  paint()
  void load()
}

export function unmount(): void {
  live?.dispose()
  past?.view.dispose()
  live = null
  past = null
  root = null
  nav = null
  detail = null
}
