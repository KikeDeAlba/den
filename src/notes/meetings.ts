import { searchTranscripts, type MeetingRecord, type PageMeeting, type PageNode, type Space } from '../bita.ts'
import { element, icon } from '../dom.ts'
import { MEETING_KINDS, isRemote } from './meeting.ts'
import { foldForSearch } from './markdown.ts'
import { formatSize } from './rail.ts'
import './meetings.css'

export interface MeetingsContext {
  space: Space | null
  records: MeetingRecord[] | null
  railOpen: boolean
  onExpandRail: () => void
  onOpenPage: (pageId: number) => void
  onStorage: () => void
}

type KindFilter = 'all' | 'remote' | 'in-person'
type MediaFilter = 'any' | 'video' | 'audio'

interface MeetingRow {
  page: PageNode
  meeting: PageMeeting
  record: MeetingRecord | null
  title: string
  crumb: string
  flavor: 'video' | 'audio' | 'remote' | 'in-person'
}

const OLD_DAYS = 30
const DAY_MS = 86_400_000

let kind: KindFilter = 'all'
let media: MediaFilter = 'any'
let query = ''
let newestFirst = true
let transcriptIds: Set<number> | null = null
let transcriptToken = 0
let lastSpace: string | null = null

export function meetingRows(space: Space | null, records: MeetingRecord[] | null): MeetingRow[] {
  if (space === null) return []
  const byEntry = new Map<number, MeetingRecord>()
  for (const record of records ?? []) {
    if (typeof record.bitaEntryId === 'number') byEntry.set(record.bitaEntryId, record)
  }
  const rows: MeetingRow[] = []
  const walk = (pages: PageNode[], trail: string[]): void => {
    for (const page of pages) {
      for (const meeting of page.meetings ?? []) {
        if (!MEETING_KINDS.includes(meeting.kind)) continue
        const record = byEntry.get(meeting.entryId) ?? null
        const title = record !== null && record.title.trim().length > 0 ? record.title : page.title
        const path = title === page.title ? trail : [...trail, page.title]
        rows.push({
          page,
          meeting,
          record,
          title,
          crumb: path.length === 0 ? 'Raíz del espacio' : path.join(' / '),
          flavor: !isRemote(meeting) ? 'in-person' : record === null ? 'remote' : record.hasVideo ? 'video' : 'audio',
        })
      }
      walk(page.children ?? [], [...trail, page.title])
    }
  }
  walk(space.pages, [])
  return rows
}

export function meetingCount(space: Space | null): number {
  return meetingRows(space, null).length
}

function durationText(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`
}

function totalText(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const rest = minutes % 60
  return rest === 0 ? `${Math.floor(minutes / 60)} h` : `${Math.floor(minutes / 60)} h ${rest} min`
}

function monthTitle(iso: string): string {
  const date = new Date(iso)
  const text = date.toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }).replace(' de ', ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

function visible(rows: MeetingRow[]): MeetingRow[] {
  const needle = foldForSearch(query.trim())
  return rows
    .filter((row) => kind === 'all' || (kind === 'remote' ? row.flavor !== 'in-person' : row.flavor === 'in-person'))
    .filter((row) => media === 'any' || (media === 'video' ? row.flavor === 'video' : row.flavor !== 'video'))
    .filter(
      (row) =>
        needle.length === 0 ||
        foldForSearch(`${row.title} ${row.crumb}`).includes(needle) ||
        (transcriptIds?.has(row.meeting.entryId) ?? false),
    )
    .sort((left, right) =>
      newestFirst
        ? right.meeting.startedAt.localeCompare(left.meeting.startedAt)
        : left.meeting.startedAt.localeCompare(right.meeting.startedAt),
    )
}

function tag(row: MeetingRow): HTMLElement {
  const labels: Record<MeetingRow['flavor'], [string, 'screen' | 'wave' | 'mic']> = {
    video: ['Remota · video', 'screen'],
    audio: ['Remota · solo audio', 'wave'],
    remote: ['Remota', 'screen'],
    'in-person': ['Presencial', 'mic'],
  }
  const [label, glyph] = labels[row.flavor]
  const chip = element('span', `meetings-tag meetings-tag--${row.flavor}`)
  chip.append(icon(glyph, 11), element('span', '', label))
  return chip
}

function rowButton(row: MeetingRow, context: MeetingsContext): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'meetings-row'
  const date = new Date(row.meeting.startedAt)
  const day = element('span', 'meetings-day')
  day.append(
    element('span', 'meetings-day-number', String(date.getDate()).padStart(2, '0')),
    element('span', 'meetings-day-name', date.toLocaleDateString('es-MX', { weekday: 'short' }).replace('.', '')),
  )
  const lines = element('span', 'meetings-lines')
  lines.append(element('span', 'meetings-title', row.title), element('span', 'meetings-crumb', row.crumb))
  button.append(
    day,
    lines,
    tag(row),
    element('span', 'kbd meetings-figure', durationText(row.meeting.durationSeconds)),
    element('span', 'kbd meetings-figure', row.record === null ? '—' : formatSize(row.record.storage.totalBytes)),
  )
  button.addEventListener('click', () => context.onOpenPage(row.page.pageId))
  return button
}

function segmented<T extends string>(label: string, options: [T, string][], value: T, onPick: (next: T) => void): HTMLElement {
  const group = element('div', 'seg meetings-seg')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', label)
  for (const [key, text] of options) {
    const button = document.createElement('button')
    button.type = 'button'
    button.textContent = text
    button.setAttribute('aria-pressed', String(key === value))
    button.addEventListener('click', () => onPick(key))
    group.append(button)
  }
  return group
}

function sumBytes(rows: MeetingRow[]): number {
  return rows.reduce((total, row) => total + (row.record?.storage.totalBytes ?? 0), 0)
}

export function renderMeetings(host: HTMLElement, context: MeetingsContext): void {
  const slug = context.space?.projectSlug ?? null
  if (slug !== lastSpace) {
    lastSpace = slug
    transcriptIds = null
  }
  const standing = host.querySelector<HTMLElement>('.meetings')
  const scroller = standing?.querySelector<HTMLElement>('.meetings-scroll')
  const top = scroller?.scrollTop ?? 0
  const focused = document.activeElement?.id === 'meetings-query'

  const all = meetingRows(context.space, context.records)
  const name = context.space?.projectName ?? 'este espacio'

  const view = element('div', 'meetings')
  const bar = element('div', 'reader-bar')
  if (!context.railOpen) {
    const unfold = document.createElement('button')
    unfold.type = 'button'
    unfold.className = 'icon-button reader-step'
    unfold.setAttribute('aria-label', 'Desplegar el árbol')
    unfold.append(icon('panelLeft', 14))
    unfold.addEventListener('click', context.onExpandRail)
    bar.append(unfold)
  }
  const crumb = element('nav', 'reader-crumb')
  crumb.append(element('span', 'crumb-space', name), element('span', 'crumb-sep', '/'), element('span', 'crumb-here', 'Reuniones'))
  bar.append(crumb)

  const scroll = element('div', 'meetings-scroll')
  const head = element('div', 'meetings-head')
  const titles = element('div', 'meetings-titles')
  const seconds = all.reduce((total, row) => total + row.meeting.durationSeconds, 0)
  const bytes = sumBytes(all)
  const summary = [
    `${all.length} ${all.length === 1 ? 'reunión' : 'reuniones'} en ${name}`,
    `${totalText(seconds)} ${all.length === 1 ? 'grabada' : 'grabadas'}`,
    ...(context.records === null ? [] : [formatSize(bytes)]),
  ].join(' · ')
  titles.append(element('h1', 'meetings-h1', 'Reuniones'), element('p', 'meetings-summary', summary))

  const field = element('label', 'meetings-search')
  const glass = element('span', 'search-glass')
  glass.append(icon('search', 13))
  const input = document.createElement('input')
  input.type = 'search'
  input.id = 'meetings-query'
  input.placeholder = 'Buscar por título o transcripción'
  input.setAttribute('aria-label', 'Buscar reuniones')
  input.autocomplete = 'off'
  input.spellcheck = false
  input.value = query
  input.addEventListener('input', () => {
    query = input.value
    lookupTranscripts(all, host, context)
    paintList()
  })
  field.append(glass, input)
  head.append(titles, field)

  const filters = element('div', 'meetings-filters')
  const repaint = (): void => renderMeetings(host, context)
  const order = document.createElement('button')
  order.type = 'button'
  order.className = 'meetings-order'
  order.append(element('span', '', newestFirst ? 'Más recientes primero' : 'Más antiguas primero'), icon(newestFirst ? 'chevronDown' : 'up', 12))
  order.addEventListener('click', () => {
    newestFirst = !newestFirst
    repaint()
  })
  filters.append(
    segmented<KindFilter>('Tipo', [['all', 'Todas'], ['remote', 'Remotas'], ['in-person', 'Presenciales']], kind, (next) => {
      kind = next
      repaint()
    }),
    segmented<MediaFilter>('Medios', [['any', 'Cualquiera'], ['video', 'Con video'], ['audio', 'Solo audio']], media, (next) => {
      media = next
      repaint()
    }),
    element('span', 'spacer'),
    order,
  )

  const list = element('div', 'meetings-list')
  scroll.append(head, filters, list)
  view.append(bar, scroll)

  function paintList(): void {
    list.replaceChildren()
    if (context.space === null) {
      list.append(element('p', 'meetings-empty', 'Elige un espacio.'))
      return
    }
    const rows = visible(all)
    if (all.length === 0) {
      list.append(element('p', 'meetings-empty', `${name} todavía no tiene reuniones grabadas.`))
      return
    }
    if (rows.length === 0) {
      list.append(element('p', 'meetings-empty', 'Ninguna reunión coincide con los filtros.'))
      return
    }
    let month = ''
    let group: MeetingRow[] = []
    const flush = (): void => {
      if (group.length === 0) return
      const first = group[0] as MeetingRow
      const header = element('div', 'meetings-month')
      const figures = [`${group.length} ${group.length === 1 ? 'reunión' : 'reuniones'}`]
      if (context.records !== null) figures.push(formatSize(sumBytes(group)))
      header.append(element('h2', '', monthTitle(first.meeting.startedAt)), element('span', 'kbd', figures.join(' · ')))
      list.append(header, ...group.map((row) => rowButton(row, context)))
      group = []
    }
    for (const row of rows) {
      const key = row.meeting.startedAt.slice(0, 7)
      if (key !== month) {
        flush()
        month = key
      }
      group.push(row)
    }
    flush()
  }

  paintList()
  host.replaceChildren(view)
  scroll.scrollTop = top
  if (focused) {
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }
}

function lookupTranscripts(rows: MeetingRow[], host: HTMLElement, context: MeetingsContext): void {
  const token = transcriptToken + 1
  transcriptToken = token
  const needle = query.trim()
  if (needle.length < 3) {
    transcriptIds = null
    return
  }
  window.setTimeout(() => {
    if (token !== transcriptToken) return
    void searchTranscripts(
      needle,
      rows.map((row) => row.meeting.entryId),
    )
      .then((hits) => {
        if (token !== transcriptToken) return
        transcriptIds = new Set(hits.filter((hit) => hit.matchCount > 0).map((hit) => hit.entryId))
        renderMeetings(host, context)
      })
      .catch(() => undefined)
  }, 250)
}

export function meetingsAside(context: MeetingsContext): HTMLElement[] {
  const rows = meetingRows(context.space, context.records)
  const label = element('div', 'aside-label', 'Este espacio')
  if (context.records === null) return [label, element('p', 'aside-note', 'Leyendo las grabaciones…')]
  const now = Date.now()
  const old = rows
    .filter((row) => row.flavor === 'video' && now - Date.parse(row.meeting.startedAt) > OLD_DAYS * DAY_MS)
    .reduce((total, row) => total + (row.record?.storage.recordingBytes ?? 0), 0)
  const total = element('div', 'aside-stat')
  total.append(
    element('span', 'aside-stat-figure', formatSize(sumBytes(rows))),
    element('span', 'aside-stat-label', `en ${rows.length} ${rows.length === 1 ? 'reunión' : 'reuniones'}`),
  )
  const stale = element('div', 'aside-stat')
  stale.append(
    element('span', 'aside-stat-figure aside-stat-figure--warn', formatSize(old)),
    element('span', 'aside-stat-label', 'en videos de hace más de 30 días'),
  )
  const link = document.createElement('button')
  link.type = 'button'
  link.className = 'aside-link'
  link.append(element('span', '', 'Revisar en Almacenamiento'), icon('next', 12))
  link.addEventListener('click', context.onStorage)
  return [label, total, stale, link]
}
