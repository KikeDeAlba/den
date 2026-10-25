import type { BacklogItem } from '../../bita.ts'

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
