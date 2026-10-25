import './storage.css'
import {
  describeProblem,
  meetingDelete,
  meetingPrune,
  meetingStripVideo,
  storageReport,
  type MeetingRecord,
  type PageNode,
  type Problem,
  type Space,
  type StorageReport,
} from '../bita.ts'
import { element, icon } from '../dom.ts'
import { projectColor } from '../shell/colors.ts'
import {
  button,
  confirmDialog,
  estimateCompressed,
  formatBytes,
  isCompressing,
  onMediaJobs,
  openCompressDialog,
  openStripDialog,
  startCompression,
} from './media-dialogs.ts'

export interface StorageContext {
  spaces: Space[]
  activeSpace: Space | null
  railOpen: boolean
  onExpandRail: () => void
  onOpenPage: (pageId: number) => void
  beforeReplace: (meetingId: string) => void
  lockSpace?: boolean
}

type SortKey = 'title' | 'when' | 'video' | 'audio' | 'intermediate' | 'total'

interface Row {
  record: MeetingRecord
  page: PageNode | null
  space: Space | null
  when: number
  ageDays: number
  video: number | null
  audio: number | null
  intermediate: number | null
  total: number
}

const OLD_DAYS = 60
const DAY_MS = 86_400_000
const TOTAL_TTL_MS = 60_000

let report: StorageReport | null = null
let measuredAt = 0
let loading = false
let failure: Problem | null = null
let actionFailure: string | null = null
let sortKey: SortKey = 'total'
let sortDescending = true
let spaceFilter: string | null = null
let onlyOrphans = false
let spaceMenuOpen = false
let rowMenu: string | null = null
let busy: string | null = null
const selected = new Set<string>()
const compressQueue: string[] = []
let host: HTMLElement | null = null
let context: StorageContext | null = null
let root: HTMLElement | null = null
let unsubscribe: (() => void) | null = null
let reportCache: { at: number; value: Promise<StorageReport> } | null = null

function cachedReport(): Promise<StorageReport> {
  const now = Date.now()
  if (reportCache !== null && now - reportCache.at < TOTAL_TTL_MS) return reportCache.value
  const value = storageReport()
  reportCache = { at: now, value }
  value.catch(() => {
    reportCache = null
  })
  return value
}

export function storageTotal(): Promise<number> {
  return cachedReport().then(sumReport)
}

export function spaceStorageTotal(spaces: Space[], slug: string): Promise<number> {
  return cachedReport().then((value) => {
    const space = spaces.find((candidate) => candidate.projectSlug === slug)
    if (space === undefined) return 0
    const meetings = rowsOf(value, spaces)
      .filter((row) => row.space?.projectSlug === slug)
      .reduce((sum, row) => sum + row.total, 0)
    return meetings + pagesBytes(space)
  })
}

function pagesBytes(space: Space): number {
  const walk = (pages: PageNode[]): number =>
    pages.reduce((sum, page) => sum + page.byteSize + walk(page.children ?? []), 0)
  return walk(space.pages)
}

function lockedSlug(current: StorageContext | null): string | null {
  return current?.lockSpace === true ? (current.activeSpace?.projectSlug ?? null) : null
}

function effectiveFilter(): string | null {
  return context?.lockSpace === true ? lockedSlug(context) : spaceFilter
}

function sumReport(value: StorageReport): number {
  return value.dbBytes + value.docsBytes + value.meetings.reduce((sum, meeting) => sum + meeting.storage.totalBytes, 0)
}

export function renderStorage(target: HTMLElement, next: StorageContext): void {
  host = target
  context = next
  if (unsubscribe === null) {
    unsubscribe = onMediaJobs(() => {
      void reload()
      pumpQueue()
    })
  }
  if (report === null && !loading) void reload()
  paint(true)
}

async function reload(): Promise<void> {
  loading = true
  reportCache = null
  try {
    report = await storageReport()
    measuredAt = Date.now()
    failure = null
    reportCache = { at: Date.now(), value: Promise.resolve(report) }
    const ids = new Set(report.meetings.map((meeting) => meeting.id))
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id)
  } catch (error) {
    failure = describeProblem(error)
  }
  loading = false
  paint(false)
}

function mounted(): boolean {
  return host !== null && root !== null && root.isConnected && root.parentElement === host
}

function paint(force: boolean): void {
  if (host === null || context === null) return
  if (!force && !mounted()) return
  const scroller = root?.querySelector<HTMLElement>('.st-scroll')
  const scrollTop = mounted() && scroller ? scroller.scrollTop : 0
  root = build(context)
  host.replaceChildren(root)
  const fresh = root.querySelector<HTMLElement>('.st-scroll')
  if (fresh) fresh.scrollTop = scrollTop
}

function pageIndex(spaces: Space[]): Map<number, { page: PageNode; space: Space }> {
  const index = new Map<number, { page: PageNode; space: Space }>()
  const walk = (pages: PageNode[], space: Space): void => {
    for (const page of pages) {
      for (const meeting of page.meetings ?? []) {
        if (!index.has(meeting.entryId)) index.set(meeting.entryId, { page, space })
      }
      walk(page.children ?? [], space)
    }
  }
  for (const space of spaces) walk(space.pages, space)
  return index
}

function rowsOf(value: StorageReport, spaces: Space[]): Row[] {
  const index = pageIndex(spaces)
  const now = Date.now()
  return value.meetings.map((record) => {
    const found = record.bitaEntryId == null ? undefined : index.get(record.bitaEntryId)
    const when = Date.parse(record.startedAt ?? record.createdAt)
    const stamp = Number.isNaN(when) ? now : when
    const recording = record.storage.recordingBytes
    return {
      record,
      page: found?.page ?? null,
      space: found?.space ?? null,
      when: stamp,
      ageDays: Math.max(0, Math.floor((now - stamp) / DAY_MS)),
      video: record.hasVideo && recording > 0 ? recording : null,
      audio: !record.hasVideo && recording > 0 ? recording : null,
      intermediate: record.storage.intermediateBytes > 0 ? record.storage.intermediateBytes : null,
      total: record.storage.totalBytes,
    }
  })
}

function visibleRows(rows: Row[]): Row[] {
  const filtered = rows.filter((row) => {
    if (onlyOrphans) return row.page === null
    const filter = effectiveFilter()
    if (filter !== null && row.space?.projectSlug !== filter) return false
    return true
  })
  const value = (row: Row): number | string => {
    if (sortKey === 'title') return row.record.title.toLocaleLowerCase('es')
    if (sortKey === 'when') return row.when
    if (sortKey === 'video') return row.video ?? -1
    if (sortKey === 'audio') return row.audio ?? -1
    if (sortKey === 'intermediate') return row.intermediate ?? -1
    return row.total
  }
  return filtered.sort((left, right) => {
    const a = value(left)
    const b = value(right)
    const order = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b, 'es') : Number(a) - Number(b)
    return sortDescending ? -order : order
  })
}

function relativeDays(days: number): string {
  if (days === 0) return 'hoy'
  if (days === 1) return 'ayer'
  return `hace ${days} días`
}

function measuredLabel(): string {
  if (measuredAt === 0) return 'midiendo…'
  const minutes = Math.floor((Date.now() - measuredAt) / 60_000)
  if (minutes < 1) return 'medido hace un momento'
  return minutes === 1 ? 'medido hace 1 min' : `medido hace ${minutes} min`
}

function processed(record: MeetingRecord): boolean {
  return (record.transcript ?? record.transcriptSegments ?? record.summary ?? null) !== null
}

function build(current: StorageContext): HTMLElement {
  const wrap = element('div', 'st-root')
  wrap.append(bar(current))
  const scroll = element('div', 'st-scroll')
  const body = element('div', 'st-body')
  scroll.append(body)
  wrap.append(scroll)

  const all = report === null ? [] : rowsOf(report, current.spaces)
  const locked = lockedSlug(current)
  const rows = current.lockSpace === true ? all.filter((row) => row.space?.projectSlug === locked) : all
  const visible = visibleRows(all)
  const pages =
    current.lockSpace === true
      ? (current.activeSpace?.pageCount ?? 0)
      : current.spaces.reduce((sum, space) => sum + space.pageCount, 0)
  const recorded = current.lockSpace === true ? rows.length : (report?.meetings.length ?? 0)
  const prefix = current.lockSpace === true ? `${current.activeSpace?.projectName ?? 'Sin proyecto'} · ` : ''

  const top = element('div', 'st-top')
  const heading = element('div', 'st-heading')
  heading.append(
    element('h1', 'st-title', 'Almacenamiento'),
    element(
      'p',
      'st-lede',
      report === null ? (failure === null ? 'Midiendo…' : 'No pude medir el almacenamiento.') : `${prefix}${recorded} ${recorded === 1 ? 'reunión grabada' : 'reuniones grabadas'} · ${pages} páginas · ${measuredLabel()}`,
    ),
  )
  top.append(heading)
  if (current.lockSpace !== true) top.append(spacePicker(current, rows))
  body.append(top)

  if (failure !== null && report === null) {
    body.append(problemBlock(failure))
    return wrap
  }
  if (report === null) {
    body.append(element('p', 'st-empty', 'Leyendo lo que ocupa cada reunión…'))
    return wrap
  }
  if (!report.recapAvailable) {
    body.append(element('p', 'st-notice', 'recap no está instalado en este equipo: solo se mide lo de bita.'))
  }

  body.append(
    current.lockSpace === true
      ? spaceUsage(rows, current.activeSpace)
      : usage(report, spaceFilter === null && !onlyOrphans ? rows : visible),
  )
  const hints = suggestions(rows, all.filter((row) => row.page === null))
  if (hints !== null) body.append(hints)
  if (actionFailure !== null) {
    const line = element('p', 'st-error')
    line.append(icon('warning', 13), element('span', '', actionFailure))
    body.append(line)
  }
  if (onlyOrphans) {
    const chip = button('Solo reuniones sin página ×', 'st-chip', () => {
      onlyOrphans = false
      paint(false)
    })
    body.append(chip)
  }
  const chosen = visible.filter((row) => selected.has(row.record.id))
  if (chosen.length > 0) body.append(bulkBar(chosen))
  body.append(table(visible, current))
  return wrap
}

function bar(current: StorageContext): HTMLElement {
  const row = element('div', 'reader-bar st-bar')
  if (!current.railOpen) {
    const unfold = document.createElement('button')
    unfold.type = 'button'
    unfold.className = 'icon-button reader-step'
    unfold.setAttribute('aria-label', 'Desplegar el árbol')
    unfold.append(icon('panelLeft', 14))
    unfold.addEventListener('click', current.onExpandRail)
    row.append(unfold)
  }
  row.append(element('span', 'st-bar-title', 'Almacenamiento'), element('span', 'spacer'))
  if (loading) row.append(element('span', 'v2-kbd', 'midiendo…'))
  row.append(element('span', 'v2-kbd', '~/Recap · ~/.local/share/bita · ~/.local/share/inkwell'))
  const refresh = document.createElement('button')
  refresh.type = 'button'
  refresh.className = 'icon-button reader-step'
  refresh.setAttribute('aria-label', 'Volver a medir')
  refresh.append(icon('refresh', 13))
  refresh.disabled = loading
  refresh.addEventListener('click', () => {
    void reload()
  })
  row.append(refresh)
  return row
}

function spacePicker(current: StorageContext, rows: Row[]): HTMLElement {
  const wrap = element('div', 'st-picker')
  const chosen = current.spaces.find((space) => space.projectSlug === spaceFilter) ?? null
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = 'v2-btn'
  trigger.setAttribute('aria-haspopup', 'listbox')
  trigger.setAttribute('aria-expanded', String(spaceMenuOpen))
  const dot = element('span', 'dot')
  dot.style.background = chosen === null ? 'var(--elev-strong)' : projectColor(chosen.projectId)
  trigger.append(dot, element('span', '', chosen?.projectName ?? 'Todos los espacios'), icon('chevronDown', 12))
  trigger.addEventListener('click', () => {
    spaceMenuOpen = !spaceMenuOpen
    paint(false)
  })
  wrap.append(trigger)
  if (!spaceMenuOpen) return wrap

  const menu = element('div', 'st-menu')
  menu.setAttribute('role', 'listbox')
  const counts = new Map<string, number>()
  for (const row of rows) {
    if (row.space !== null) counts.set(row.space.projectSlug, (counts.get(row.space.projectSlug) ?? 0) + 1)
  }
  const option = (label: string, slug: string | null, color: string, count: number): HTMLElement => {
    const item = document.createElement('button')
    item.type = 'button'
    item.className = slug === spaceFilter ? 'st-menu-option st-menu-option--on' : 'st-menu-option'
    item.setAttribute('role', 'option')
    item.setAttribute('aria-selected', String(slug === spaceFilter))
    const bead = element('span', 'dot')
    bead.style.background = color
    item.append(bead, element('span', 'st-menu-name', label), element('span', 'v2-kbd', String(count)))
    item.addEventListener('click', () => {
      spaceFilter = slug
      spaceMenuOpen = false
      paint(false)
    })
    return item
  }
  menu.append(option('Todos los espacios', null, 'var(--elev-strong)', rows.length))
  for (const space of current.spaces) {
    const count = counts.get(space.projectSlug) ?? 0
    if (count === 0) continue
    menu.append(option(space.projectName ?? 'Sin proyecto', space.projectSlug, projectColor(space.projectId), count))
  }
  wrap.append(menu)
  return wrap
}

interface UsagePart {
  label: string
  color: string
  bytes: number
}

function meetingParts(rows: Row[]): UsagePart[] {
  const sum = (pick: (row: Row) => number): number => rows.reduce((total, row) => total + pick(row), 0)
  return [
    { label: 'Videos', color: 'var(--blue)', bytes: sum((row) => row.video ?? 0) },
    { label: 'WAV intermedios', color: 'var(--estimate)', bytes: sum((row) => row.intermediate ?? 0) },
    { label: 'Audio', color: 'var(--aqua)', bytes: sum((row) => row.audio ?? 0) },
    { label: 'Capturas', color: 'var(--purple)', bytes: sum((row) => row.record.storage.framesBytes) },
  ]
}

function spaceUsage(rows: Row[], space: Space | null): HTMLElement {
  const other = rows.reduce((total, row) => total + row.record.storage.otherBytes, 0)
  return usageSection([
    ...meetingParts(rows),
    { label: 'Documentos y diagramas', color: 'var(--running)', bytes: (space === null ? 0 : pagesBytes(space)) + other },
  ])
}

function usage(value: StorageReport, rows: Row[]): HTMLElement {
  const other = rows.reduce((total, row) => total + row.record.storage.otherBytes, 0)
  return usageSection([
    ...meetingParts(rows),
    { label: 'Documentos y diagramas', color: 'var(--running)', bytes: value.docsBytes + other },
    { label: 'bita.db', color: 'var(--fg-mute)', bytes: value.dbBytes },
  ])
}

function usageSection(parts: UsagePart[]): HTMLElement {
  const total = parts.reduce((all, part) => all + part.bytes, 0)

  const section = element('section', 'st-usage')
  section.setAttribute('aria-label', 'Uso total')
  const figure = element('div', 'st-usage-total')
  figure.append(element('span', 'st-usage-figure', formatBytes(total)), element('span', 'st-usage-note', 'en disco'))
  const stack = element('div', 'st-stack')
  stack.setAttribute('role', 'img')
  stack.setAttribute('aria-label', parts.map((part) => `${part.label} ${formatBytes(part.bytes)}`).join(', '))
  for (const part of parts) {
    if (part.bytes <= 0) continue
    const slice = element('span', 'st-stack-part')
    slice.style.flex = String(Math.max(0.6, (part.bytes / Math.max(1, total)) * 100))
    slice.style.background = part.color
    slice.title = `${part.label} · ${formatBytes(part.bytes)}`
    stack.append(slice)
  }
  const legend = element('div', 'st-legend')
  for (const part of parts) {
    const item = element('span', 'st-legend-item')
    const square = element('span', 'st-square')
    square.style.background = part.color
    item.append(square, document.createTextNode(part.label), element('span', 'st-legend-value', formatBytes(part.bytes)))
    legend.append(item)
  }
  section.append(figure, stack, legend)
  return section
}

function suggestionCard(tone: string, kicker: string, title: string, size: number, actions: HTMLElement[]): HTMLElement {
  const card = element('div', 'st-suggestion')
  const label = element('span', 'st-suggestion-kicker', kicker)
  label.style.color = tone
  const row = element('span', 'st-suggestion-actions')
  row.append(...actions)
  card.append(label, element('span', 'st-suggestion-title', title), element('span', 'st-suggestion-size', formatBytes(size)), row)
  return card
}

function suggestions(rows: Row[], orphans: Row[]): HTMLElement | null {
  const section = element('section', 'st-suggestions')
  section.setAttribute('aria-label', 'Sugerencias')

  const prunable = rows.filter((row) => row.intermediate !== null && processed(row.record))
  if (prunable.length > 0) {
    const size = prunable.reduce((sum, row) => sum + (row.intermediate ?? 0), 0)
    section.append(
      suggestionCard(
        'var(--estimate)',
        'Sin riesgo',
        `WAV intermedios de ${prunable.length} ${prunable.length === 1 ? 'reunión ya transcrita' : 'reuniones ya transcritas'}`,
        size,
        [actionButton('Borrar intermedios', () => void pruneMany(prunable.map((row) => row.record)))],
      ),
    )
  }

  const old = rows.filter((row) => row.video !== null && row.ageDays > OLD_DAYS && !isCompressing(row.record.id))
  if (old.length > 0) {
    const size = old.reduce((sum, row) => sum + (row.video ?? 0), 0)
    const compressed = old.reduce((sum, row) => sum + Math.min(row.video ?? 0, estimateCompressed(row.record, 'medium')), 0)
    section.append(
      suggestionCard('var(--blue)', 'Antiguas', `Videos de hace más de ${OLD_DAYS} días · ${old.length} ${old.length === 1 ? 'reunión' : 'reuniones'}`, size, [
        actionButton(`Comprimir · ≈ ${formatBytes(compressed)}`, () => void compressMany(old.map((row) => row.record))),
        actionButton('Solo audio', () => void stripMany(old.map((row) => row.record))),
      ]),
    )
  }

  if (orphans.length > 0) {
    const size = orphans.reduce((sum, row) => sum + row.total, 0)
    section.append(
      suggestionCard('var(--purple)', 'Huérfanas', `Reuniones sin página en inkwell · ${orphans.length}`, size, [
        actionButton('Revisar', () => {
          onlyOrphans = true
          spaceFilter = null
          paint(false)
        }),
      ]),
    )
  }

  return section.childElementCount === 0 ? null : section
}

function actionButton(label: string, run: () => void, className = 'v2-btn'): HTMLButtonElement {
  const node = button(label, className, run)
  node.disabled = busy !== null
  return node
}

function bulkBar(chosen: Row[]): HTMLElement {
  const barNode = element('div', 'st-bulk')
  const size = chosen.reduce((sum, row) => sum + row.total, 0)
  barNode.append(
    element('span', 'st-bulk-count', `${chosen.length} ${chosen.length === 1 ? 'seleccionada' : 'seleccionadas'}`),
    element('span', 'st-bulk-size', `· ${formatBytes(size)}`),
    element('span', 'spacer'),
  )
  if (busy !== null) barNode.append(element('span', 'v2-kbd', busy))
  const records = chosen.map((row) => row.record)
  const withVideo = records.filter((record) => record.hasVideo)
  const withIntermediates = records.filter((record) => record.storage.intermediateBytes > 0)
  const compress = actionButton('Comprimir video', () => {
    const only = withVideo[0]
    if (withVideo.length === 1 && only !== undefined) {
      compressOne(only)
      return
    }
    void compressMany(withVideo)
  })
  compress.disabled ||= withVideo.length === 0
  const strip = actionButton('Borrar video', () => {
    const only = withVideo[0]
    if (withVideo.length === 1 && only !== undefined) {
      stripOne(only)
      return
    }
    void stripMany(withVideo)
  })
  strip.disabled ||= withVideo.length === 0
  const prune = actionButton('Borrar intermedios', () => void pruneMany(withIntermediates))
  prune.disabled ||= withIntermediates.length === 0
  const remove = actionButton('Borrar reunión', () => void deleteMany(records), 'v2-btn v2-btn--danger')
  barNode.append(compress, strip, prune, remove)
  return barNode
}

function sortHeader(label: string, key: SortKey, numeric: boolean): HTMLElement {
  const cell = element('th', numeric ? 'st-num' : '')
  const on = sortKey === key
  cell.setAttribute('aria-sort', on ? (sortDescending ? 'descending' : 'ascending') : 'none')
  const trigger = document.createElement('button')
  trigger.type = 'button'
  trigger.className = on ? 'st-sort st-sort--on' : 'st-sort'
  trigger.textContent = on ? `${label} ${sortDescending ? '↓' : '↑'}` : label
  trigger.addEventListener('click', () => {
    if (sortKey === key) sortDescending = !sortDescending
    else {
      sortKey = key
      sortDescending = key !== 'title'
    }
    paint(false)
  })
  cell.append(trigger)
  return cell
}

function sizeCell(bytes: number | null, strong = false): HTMLElement {
  return element('td', strong ? 'st-num st-mono st-strong' : 'st-num st-mono', bytes === null ? '—' : formatBytes(bytes))
}

function table(rows: Row[], current: StorageContext): HTMLElement {
  if (rows.length === 0) {
    return element('p', 'st-empty', onlyOrphans ? 'Todas las reuniones tienen página.' : 'No hay reuniones grabadas aquí.')
  }
  const grid = element('table', 'st-table')
  const head = element('thead')
  const headRow = element('tr')
  const allCell = element('th', 'st-check')
  const all = document.createElement('input')
  all.type = 'checkbox'
  all.setAttribute('aria-label', 'Seleccionar todas')
  const allChosen = rows.every((row) => selected.has(row.record.id))
  all.checked = allChosen
  all.indeterminate = !allChosen && rows.some((row) => selected.has(row.record.id))
  all.addEventListener('change', () => {
    for (const row of rows) {
      if (all.checked) selected.add(row.record.id)
      else selected.delete(row.record.id)
    }
    paint(false)
  })
  allCell.append(all)
  const actionsHead = element('th')
  actionsHead.append(element('span', 'visually-hidden', 'Acciones'))
  headRow.append(
    allCell,
    sortHeader('Reunión', 'title', false),
    sortHeader('Cuándo', 'when', false),
    sortHeader('Video', 'video', true),
    sortHeader('Audio', 'audio', true),
    sortHeader('Intermedios', 'intermediate', true),
    sortHeader('Total', 'total', true),
    actionsHead,
  )
  head.append(headRow)

  const body = element('tbody')
  for (const row of rows) {
    const id = row.record.id
    const tr = element('tr', selected.has(id) ? 'st-row st-row--on' : 'st-row')
    const checkCell = element('td', 'st-check')
    const check = document.createElement('input')
    check.type = 'checkbox'
    check.checked = selected.has(id)
    check.setAttribute('aria-label', `Seleccionar ${row.record.title}`)
    check.addEventListener('change', () => {
      if (check.checked) selected.add(id)
      else selected.delete(id)
      paint(false)
    })
    checkCell.append(check)

    const nameCell = element('td', 'st-name-cell')
    const name = element('span', 'st-name')
    const dot = element('span', 'dot')
    dot.style.background = row.space === null ? 'transparent' : projectColor(row.space.projectId)
    if (row.space === null) dot.style.border = '1px solid var(--elev-strong)'
    const pageId = row.page?.pageId
    const title =
      pageId === undefined
        ? element('span', 'st-name-text', row.record.title)
        : button(row.record.title, 'st-name-text st-name-link', () => current.onOpenPage(pageId))
    title.title = row.page === null ? 'Sin página en inkwell' : `Abrir ${row.page.title}`
    name.append(dot, title)
    nameCell.append(name)
    if (isCompressing(id)) nameCell.append(element('span', 'st-tag st-tag--busy', 'comprimiendo…'))
    else if (row.ageDays > OLD_DAYS) nameCell.append(element('span', 'st-tag', 'antigua'))
    if (!row.record.hasVideo && row.record.mode === 'remote') nameCell.append(element('span', 'v2-kbd st-aside', 'solo audio'))

    const more = element('td', 'st-more-cell')
    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'st-more'
    trigger.setAttribute('aria-label', 'Más acciones')
    trigger.setAttribute('aria-expanded', String(rowMenu === id))
    trigger.append(icon('more', 14))
    trigger.addEventListener('click', () => {
      rowMenu = rowMenu === id ? null : id
      paint(false)
    })
    more.append(trigger)
    if (rowMenu === id) more.append(rowActions(row, current))

    tr.append(
      checkCell,
      nameCell,
      element('td', 'v2-kbd', relativeDays(row.ageDays)),
      sizeCell(row.video),
      sizeCell(row.audio),
      sizeCell(row.intermediate),
      sizeCell(row.total, true),
      more,
    )
    body.append(tr)
  }
  grid.append(head, body)
  return grid
}

function rowActions(row: Row, current: StorageContext): HTMLElement {
  const menu = element('div', 'st-row-menu')
  menu.setAttribute('role', 'menu')
  const add = (label: string, run: () => void, enabled = true, danger = false): void => {
    const item = button(label, danger ? 'st-row-option st-row-option--danger' : 'st-row-option', () => {
      rowMenu = null
      run()
    })
    item.setAttribute('role', 'menuitem')
    item.disabled = !enabled || busy !== null
    menu.append(item)
  }
  const pageId = row.page?.pageId
  if (pageId !== undefined) add('Abrir la página', () => current.onOpenPage(pageId))
  add('Comprimir video', () => compressOne(row.record), row.record.hasVideo && !isCompressing(row.record.id))
  add('Borrar video', () => stripOne(row.record), row.record.hasVideo && !isCompressing(row.record.id))
  add('Borrar intermedios', () => void pruneMany([row.record]), row.intermediate !== null)
  add('Borrar reunión', () => void deleteMany([row.record]), true, true)
  return menu
}

function beforeReplace(id: string): void {
  context?.beforeReplace(id)
}

function compressOne(record: MeetingRecord): void {
  openCompressDialog(record, { frameSrc: null, beforeReplace: () => beforeReplace(record.id) })
}

function stripOne(record: MeetingRecord): void {
  openStripDialog(record, {
    beforeReplace: () => beforeReplace(record.id),
    onDone: () => {
      void reload()
    },
  })
}

async function compressMany(records: MeetingRecord[]): Promise<void> {
  const pending = records.filter((record) => record.hasVideo && !isCompressing(record.id) && !compressQueue.includes(record.id))
  if (pending.length === 0) return
  const saved = pending.reduce((sum, record) => sum + Math.max(0, record.storage.recordingBytes - estimateCompressed(record, 'medium')), 0)
  const ok = await confirmDialog({
    title: `¿Comprimir ${pending.length} ${pending.length === 1 ? 'video' : 'videos'}?`,
    body: `Calidad media (960 px · 1 fps). Se liberan ≈ ${formatBytes(saved)}. Se comprimen uno por uno en segundo plano.`,
    confirm: 'Comprimir',
  })
  if (!ok) return
  compressQueue.push(...pending.map((record) => record.id))
  pumpQueue()
  paint(false)
}

function pumpQueue(): void {
  if (report === null) return
  const running = report.meetings.some((record) => isCompressing(record.id))
  if (running) return
  const next = compressQueue.shift()
  if (next === undefined) return
  const record = report.meetings.find((candidate) => candidate.id === next)
  if (record === undefined) {
    pumpQueue()
    return
  }
  beforeReplace(record.id)
  startCompression(record, 'medium', false).catch((error: unknown) => {
    actionFailure = `${record.title}: ${describeProblem(error).message}`
    paint(false)
    pumpQueue()
  })
  paint(false)
}

async function runEach(label: string, records: MeetingRecord[], run: (record: MeetingRecord) => Promise<unknown>): Promise<void> {
  busy = label
  actionFailure = null
  paint(false)
  const failures: string[] = []
  for (const record of records) {
    try {
      await run(record)
    } catch (error) {
      failures.push(`${record.title}: ${describeProblem(error).message}`)
    }
  }
  busy = null
  actionFailure = failures.length === 0 ? null : failures.join(' · ')
  await reload()
}

async function stripMany(records: MeetingRecord[]): Promise<void> {
  const targets = records.filter((record) => record.hasVideo && !isCompressing(record.id))
  if (targets.length === 0) return
  const ok = await confirmDialog({
    title: `¿Borrar el video de ${targets.length} ${targets.length === 1 ? 'reunión' : 'reuniones'}?`,
    body: 'El audio, las capturas, la transcripción y la minuta se quedan. No se puede deshacer.',
    confirm: 'Borrar video',
    danger: true,
  })
  if (!ok) return
  await runEach('Borrando videos…', targets, (record) => {
    beforeReplace(record.id)
    return meetingStripVideo(record.id, false)
  })
}

async function pruneMany(records: MeetingRecord[]): Promise<void> {
  const targets = records.filter((record) => record.storage.intermediateBytes > 0)
  if (targets.length === 0) return
  await runEach('Borrando intermedios…', targets, (record) => meetingPrune(record.id))
}

async function deleteMany(records: MeetingRecord[]): Promise<void> {
  if (records.length === 0) return
  const size = records.reduce((sum, record) => sum + record.storage.totalBytes, 0)
  const ok = await confirmDialog({
    title: records.length === 1 ? '¿Borrar esta reunión?' : `¿Borrar ${records.length} reuniones?`,
    body: `Se borra la carpeta completa en ~/Recap (${formatBytes(size)}): grabación, capturas, transcripción y minuta. Las páginas de inkwell no se tocan. No se puede deshacer.`,
    confirm: 'Borrar reunión',
    danger: true,
  })
  if (!ok) return
  await runEach('Borrando reuniones…', records, async (record) => {
    beforeReplace(record.id)
    await meetingDelete(record.id)
    selected.delete(record.id)
  })
}

function problemBlock(problem: Problem): HTMLElement {
  const box = element('div', 'problem')
  box.append(element('div', 'problem-message', problem.message))
  if (problem.hint) box.append(element('div', 'problem-hint', problem.hint))
  return box
}
