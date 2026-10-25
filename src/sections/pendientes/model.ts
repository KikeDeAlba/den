import type { BacklogItem, BacklogKind, PageNode, Space } from '../../bita.ts'

export type IssueState = 'finding' | 'pending' | 'resolved'

export interface IssueGroup {
  state: IssueState
  label: string
  items: BacklogItem[]
}

const GROUP_LABEL: Record<IssueState, string> = {
  finding: 'Hallazgos',
  pending: 'Pendientes',
  resolved: 'Resueltos',
}

export const STATE_LABEL: Record<IssueState, string> = {
  finding: 'Hallazgo',
  pending: 'Pendiente',
  resolved: 'Resuelto',
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

export function stateOf(item: Pick<BacklogItem, 'kind' | 'status'>): IssueState {
  if (item.status === 'resolved') return 'resolved'
  return item.kind === 'finding' ? 'finding' : 'pending'
}

export function keyOf(item: Pick<BacklogItem, 'id' | 'key'>): string {
  return item.key ?? `#${item.id}`
}

export function inSpace(item: Pick<BacklogItem, 'projectId'>, projectId: number | null): boolean {
  return item.projectId === projectId
}

export function matches(item: BacklogItem, query: string): boolean {
  const needle = query.trim().toLocaleLowerCase('es')
  if (needle.length === 0) return true
  return [keyOf(item), item.title, item.body, item.pageTitle ?? ''].some((field) =>
    field.toLocaleLowerCase('es').includes(needle),
  )
}

export function findKey(items: readonly BacklogItem[], text: string): BacklogItem | undefined {
  const wanted = text.trim().replace(/^#/, '').toUpperCase()
  if (wanted.length === 0) return undefined
  return items.find((item) => keyOf(item).replace(/^#/, '').toUpperCase() === wanted || String(item.id) === wanted)
}

function newestFirst(left: BacklogItem, right: BacklogItem): number {
  const leftAt = left.status === 'resolved' ? (left.resolvedAt ?? left.updatedAt) : left.createdAt
  const rightAt = right.status === 'resolved' ? (right.resolvedAt ?? right.updatedAt) : right.createdAt
  return rightAt.localeCompare(leftAt) || right.id - left.id
}

export function groupIssues(items: readonly BacklogItem[]): IssueGroup[] {
  return (['finding', 'pending', 'resolved'] as const).map((state) => ({
    state,
    label: GROUP_LABEL[state],
    items: items.filter((item) => stateOf(item) === state).sort(newestFirst),
  }))
}

export function ageLabel(iso: string | null, now: Date): string {
  if (iso === null) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const elapsed = Math.max(0, now.getTime() - then)
  if (elapsed < HOUR_MS) return `${Math.max(1, Math.floor(elapsed / MINUTE_MS))} min`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)} h`
  if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)} d`
  return `${Math.floor(elapsed / WEEK_MS)} sem`
}

export function closePrompt(item: Pick<BacklogItem, 'id' | 'key'>): string {
  return `cierra ${keyOf(item)}`
}

export type BacklogOrigin = 'meeting' | 'extracted' | 'manual'
export type StatusFilter = 'all' | 'open' | 'resolved'
export type CreatedFilter = 'any' | 'today' | 'week' | 'old'
export type Grouping = 'state' | 'page'

export interface Filters {
  status: StatusFilter
  kind: 'all' | BacklogKind
  page: string
  origin: 'all' | BacklogOrigin
  created: CreatedFilter
}

export interface PageGroup {
  key: string
  label: string
  items: BacklogItem[]
}

export const ALL_PAGES = 'all'
export const NO_PAGE = 'none'
const OLD_DAYS = 14
const WEEK_DAYS = 7

export const ORIGIN_LABEL: Record<BacklogOrigin, string> = {
  meeting: 'Reunión',
  extracted: 'Extraída',
  manual: 'Manual',
}

export function defaultFilters(): Filters {
  return { status: 'all', kind: 'all', page: ALL_PAGES, origin: 'all', created: 'any' }
}

export function activeFilters(filters: Filters): number {
  const base = defaultFilters()
  return (Object.keys(base) as (keyof Filters)[]).filter((key) => filters[key] !== base[key]).length
}

export function meetingEntryIds(spaces: readonly Space[]): Set<number> {
  const ids = new Set<number>()
  const walk = (pages: readonly PageNode[]): void => {
    for (const page of pages) {
      for (const meeting of page.meetings ?? []) ids.add(meeting.entryId)
      walk(page.children ?? [])
    }
  }
  for (const space of spaces) walk(space.pages)
  return ids
}

export function originOf(item: Pick<BacklogItem, 'entryId' | 'source'>, meetingIds: ReadonlySet<number>): BacklogOrigin {
  if (item.entryId !== null && meetingIds.has(item.entryId)) return 'meeting'
  return item.source === 'extracted' ? 'extracted' : 'manual'
}

export function pageKeyOf(item: Pick<BacklogItem, 'pageId'>): string {
  return item.pageId === null ? NO_PAGE : String(item.pageId)
}

function daysSince(iso: string, now: Date): number {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 0
  return Math.max(0, Math.floor((now.getTime() - then) / DAY_MS))
}

export function passes(item: BacklogItem, filters: Filters, now: Date, meetingIds: ReadonlySet<number>): boolean {
  if (filters.status !== 'all' && item.status !== filters.status) return false
  if (filters.kind !== 'all' && item.kind !== filters.kind) return false
  if (filters.page !== ALL_PAGES && pageKeyOf(item) !== filters.page) return false
  if (filters.origin !== 'all' && originOf(item, meetingIds) !== filters.origin) return false
  const days = daysSince(item.createdAt, now)
  if (filters.created === 'today' && days !== 0) return false
  if (filters.created === 'week' && days > WEEK_DAYS) return false
  if (filters.created === 'old' && days <= OLD_DAYS) return false
  return true
}

export function pagesOf(items: readonly BacklogItem[]): { key: string; label: string }[] {
  const seen = new Map<string, string>()
  for (const item of items) {
    const key = pageKeyOf(item)
    if (!seen.has(key)) seen.set(key, item.pageTitle ?? 'Sin página')
  }
  return [...seen.entries()]
    .map(([key, label]) => ({ key, label }))
    .sort((left, right) => (left.key === NO_PAGE ? 1 : right.key === NO_PAGE ? -1 : left.label.localeCompare(right.label, 'es')))
}

export function groupByPage(items: readonly BacklogItem[]): PageGroup[] {
  const groups = new Map<string, PageGroup>()
  for (const item of items) {
    const key = pageKeyOf(item)
    const group = groups.get(key) ?? { key, label: item.pageTitle ?? 'Sin página', items: [] }
    group.items.push(item)
    groups.set(key, group)
  }
  const list = [...groups.values()]
  for (const group of list) group.items.sort(newestFirst)
  return list.sort((left, right) => {
    if (left.key === NO_PAGE) return 1
    if (right.key === NO_PAGE) return -1
    return (right.items[0]?.createdAt ?? '').localeCompare(left.items[0]?.createdAt ?? '')
  })
}

export function otherKind(kind: BacklogKind): BacklogKind {
  return kind === 'finding' ? 'pending' : 'finding'
}
