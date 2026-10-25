import type { Excluded, Overlap, SummaryView, WorkedView } from '../../bita.ts'

export const RANGES = [
  { id: 'hoy', label: 'Hoy' },
  { id: 'semana', label: 'Semana' },
  { id: 'mes', label: 'Mes' },
  { id: 'rango', label: 'Rango' },
] as const

export type RangeId = (typeof RANGES)[number]['id']

export const DEFAULT_RANGE: RangeId = 'hoy'

export function rangeOf(path: readonly string[]): RangeId {
  const head = path[0]
  return RANGES.find((range) => range.id === head)?.id ?? DEFAULT_RANGE
}

export function isTable(range: RangeId): range is 'hoy' | 'semana' {
  return range === 'hoy' || range === 'semana'
}

export type JiraState = 'pending' | 'registered' | 'running' | 'outside' | 'unknown'

export interface TimeRow {
  title: string
  meta: string
  projectId: number | null
  project: string
  workedSeconds: number
  estimateSeconds: number | null
  issueKey: string | null
  state: JiraState
  unregistered: number
}

export interface TimeTable {
  rows: TimeRow[]
  workedSeconds: number
  estimateSeconds: number | null
  unregistered: number
  unregisteredTasks: number
  overlaps: Overlap[]
  excluded: Excluded[]
  jira: boolean
}

const MEETING_KINDS = new Set(['meeting', 'remote-meeting', 'in-person-meeting'])

export function hoursMinutes(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds / 60))
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

function blocks(count: number): string {
  return count === 1 ? '1 bloque' : `${count} bloques`
}

function daySpan(days: readonly string[]): string {
  if (days.length <= 1) return ''
  return `${days[0]?.slice(5) ?? ''}–${days[days.length - 1]?.slice(5) ?? ''}`
}

function meta(parts: (string | false)[]): string {
  return parts.filter((part): part is string => part !== false && part !== '').join(' · ')
}

export function tallyTable(summary: SummaryView, pendingIds: ReadonlySet<number> | null, runningIds: ReadonlySet<number>): TimeTable {
  const rows = summary.groups.map((group): TimeRow => {
    const running = group.entryIds.some((id) => runningIds.has(id))
    const unregistered = group.jira && pendingIds !== null ? group.entryIds.filter((id) => pendingIds.has(id)).length : 0
    const state: JiraState = !group.jira
      ? 'outside'
      : unregistered > 0
        ? 'pending'
        : running
          ? 'running'
          : pendingIds === null
            ? 'unknown'
            : 'registered'
    return {
      title: group.summary,
      meta: meta([
        blocks(group.entryIds.length),
        daySpan(group.days),
        running && 'corriendo',
        MEETING_KINDS.has(group.kind ?? '') && 'reunión',
      ]),
      projectId: group.projectId,
      project: group.projectName ?? 'sin proyecto',
      workedSeconds: group.totalSeconds,
      estimateSeconds: group.jira ? group.estimateSeconds : null,
      issueKey: group.jira ? (group.issueKey ?? null) : null,
      state,
      unregistered,
    }
  })
  return {
    rows,
    workedSeconds: summary.totalSeconds,
    estimateSeconds: summary.estimateSeconds,
    unregistered: rows.reduce((sum, row) => sum + row.unregistered, 0),
    unregisteredTasks: rows.filter((row) => row.unregistered > 0).length,
    overlaps: summary.overlaps,
    excluded: summary.excluded,
    jira: true,
  }
}

export function workedTable(worked: WorkedView): TimeTable {
  return {
    rows: worked.groups.map((group) => ({
      title: group.summary,
      meta: meta([blocks(group.entryIds.length), daySpan(group.days), group.running && 'corriendo']),
      projectId: group.projectId,
      project: group.projectName ?? 'sin proyecto',
      workedSeconds: group.totalSeconds,
      estimateSeconds: null,
      issueKey: null,
      state: 'unknown',
      unregistered: 0,
    })),
    workedSeconds: worked.totalSeconds,
    estimateSeconds: null,
    unregistered: 0,
    unregisteredTasks: 0,
    overlaps: worked.overlaps,
    excluded: [],
    jira: false,
  }
}

export function stateLabel(row: TimeRow): string {
  if (row.state === 'outside') return 'fuera de Jira'
  if (row.state === 'pending') return `${row.unregistered} sin registrar`
  if (row.state === 'running') return 'en curso'
  if (row.state === 'registered') return 'registrado'
  return ''
}

export function unregisteredLine(table: TimeTable): string | null {
  if (!table.jira) return null
  if (table.unregistered === 0) return 'Todo lo de este rango ya está en Jira.'
  const worklogs = table.unregistered === 1 ? '1 worklog sin registrar' : `${table.unregistered} worklogs sin registrar`
  const tasks = table.unregisteredTasks === 1 ? '1 tarea' : `${table.unregisteredTasks} tareas`
  return `${worklogs} en ${tasks} · escribir en Jira lo hace Claude`
}

export function overlapLine(overlap: Overlap): string {
  return `${overlap.localDay.slice(5)}: ${hoursMinutes(overlap.trackedSeconds)} sobre ${hoursMinutes(overlap.clockSeconds)} de reloj, ${hoursMinutes(overlap.overlapSeconds)} solapados.`
}

const EXCLUDED_REASONS: Record<string, string> = {
  running: 'corriendo ahora',
  'no-project': 'sin proyecto',
  'no-description': 'sin título',
  'zero-duration': 'menos de un minuto',
}

export function excludedLine(excluded: readonly Excluded[]): string | null {
  if (excluded.length === 0) return null
  const reasons = new Map<string, number>()
  for (const item of excluded) reasons.set(item.reason, (reasons.get(item.reason) ?? 0) + 1)
  const parts = [...reasons].map(([reason, count]) => `${count} ${EXCLUDED_REASONS[reason] ?? reason}`)
  return `Quedan fuera ${excluded.length}: ${parts.join(', ')}.`
}
