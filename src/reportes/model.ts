import { projectColor } from '../shell/colors.ts'
import type { Overtime, OvertimeTotals, ProjectSeconds, RangeQuery, ReportEntry, ReportProject, ReportView } from './types.ts'

export type PresetId = 'week' | 'month' | '30d' | 'quarter' | 'custom'

export interface RangeChoice {
  preset: PresetId
  from: string
  to: string
}

export const PRESETS: { id: PresetId; label: string; phrase: string }[] = [
  { id: 'week', label: 'Esta semana', phrase: 'esta semana' },
  { id: 'month', label: 'Este mes', phrase: 'este mes' },
  { id: '30d', label: 'Últimos 30 días', phrase: 'últimos 30 días' },
  { id: 'quarter', label: 'Trimestre', phrase: 'este trimestre' },
  { id: 'custom', label: 'Personalizado…', phrase: 'personalizado' },
]

export const TOP_COLORED = 5
export const OTHERS_COLOR = 'var(--others)'
export const REST_COLOR = 'var(--fg-faint)'
export const GOAL_HOURS = 8
export const LONG_DAY_HOURS = 12

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

export function localToday(now = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

function utc(day: string): Date {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, date ?? 1))
}

export function addDays(day: string, amount: number): string {
  const moved = new Date(utc(day).getTime() + amount * 86_400_000)
  return moved.toISOString().slice(0, 10)
}

export function isWeekend(day: string): boolean {
  const weekday = utc(day).getUTCDay()
  return weekday === 0 || weekday === 6
}

export function dayOfMonth(day: string): string {
  return String(utc(day).getUTCDate())
}

export function monthName(day: string): string {
  return MONTHS[utc(day).getUTCMonth()] ?? ''
}

export function dayLabel(day: string, withYear = false): string {
  const date = utc(day)
  const base = `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()] ?? ''}`
  return withYear ? `${base} ${date.getUTCFullYear()}` : base
}

export function rangeLabel(from: string, to: string): string {
  if (from === to) return dayLabel(from, true)
  const sameYear = from.slice(0, 4) === to.slice(0, 4)
  return `${dayLabel(from, !sameYear)} – ${dayLabel(to, true)}`
}

export function shortRange(from: string, to: string): string {
  if (from === to) return dayLabel(from)
  if (from.slice(0, 7) === to.slice(0, 7)) return `${dayOfMonth(from)}–${dayLabel(to)}`
  return `${dayLabel(from)}–${dayLabel(to)}`
}

export function monthLabel(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1] ?? ''} ${month.slice(0, 4)}`
}

export function presetChoice(preset: PresetId, today: string, previous?: RangeChoice): RangeChoice {
  if (preset === '30d') return { preset, from: addDays(today, -29), to: today }
  if (preset === 'quarter') {
    const month = Number(today.slice(5, 7))
    const first = Math.floor((month - 1) / 3) * 3 + 1
    return { preset, from: `${today.slice(0, 4)}-${String(first).padStart(2, '0')}-01`, to: today }
  }
  if (preset === 'custom') {
    return { preset, from: previous?.from || addDays(today, -6), to: previous?.to || today }
  }
  return { preset, from: '', to: '' }
}

export function rangeQuery(choice: RangeChoice): RangeQuery {
  if (choice.preset === 'week' || choice.preset === 'month') return { preset: choice.preset }
  return { from: choice.from, to: choice.to }
}

export function presetPhrase(preset: PresetId): string {
  return PRESETS.find((item) => item.id === preset)?.phrase ?? ''
}

export function hours(seconds: number, digits = 1): string {
  return `${(seconds / 3600).toFixed(digits)} h`
}

export function hourValue(seconds: number): string {
  return (seconds / 3600).toFixed(1)
}

export function percent(part: number, total: number, digits = 1): string {
  if (total <= 0) return `0 %`
  return `${((part / total) * 100).toFixed(digits)} %`
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

export function projectKey(projectId: number | null): string {
  return projectId === null ? 'none' : String(projectId)
}

export const NO_PROJECT = 'Sin proyecto'

export function projectLabel(project: Pick<ReportProject, 'name' | 'projectId'> | undefined): string {
  if (project === undefined || project.projectId === null) return NO_PROJECT
  return project.name ?? NO_PROJECT
}

export function colorMap(report: ReportView): Map<string, string> {
  const colors = new Map<string, string>()
  report.projects.forEach((project, index) => {
    const own = project.color || projectColor(project.projectId)
    colors.set(projectKey(project.projectId), index < TOP_COLORED ? own : REST_COLOR)
  })
  return colors
}

export function filterReport(report: ReportView, excluded: ReadonlySet<string>): ReportView {
  if (excluded.size === 0) return report
  const keep = (item: { projectId: number | null }): boolean => !excluded.has(projectKey(item.projectId))
  const slices = (list: ProjectSeconds[]): { projects: ProjectSeconds[]; totalSeconds: number } => {
    const projects = list.filter(keep)
    return { projects, totalSeconds: projects.reduce((sum, item) => sum + item.seconds, 0) }
  }
  const projects = report.projects.filter(keep)
  const days = report.days.map((day) => ({ ...day, ...slices(day.projects) }))
  const filtered: ReportView = {
    ...report,
    projects,
    days,
    weeks: report.weeks.map((week) => ({ ...week, ...slices(week.projects) })),
    totalSeconds: projects.reduce((sum, project) => sum + project.totalSeconds, 0),
    entryCount: projects.reduce((sum, project) => sum + project.entryCount, 0),
    activeDays: days.filter((day) => day.totalSeconds > 0).length,
  }
  filtered.overlaps = []
  filtered.jiraTotals = null
  if (report.entries !== null) filtered.entries = report.entries.filter(keep)
  return filtered
}

export interface JiraSummary {
  tracked: number
  registered: number
  pending: number
  outside: number
}

export function jiraSummary(projects: ReportProject[]): JiraSummary {
  const summary: JiraSummary = { tracked: 0, registered: 0, pending: 0, outside: 0 }
  for (const project of projects) {
    if (project.jira === true) {
      const registered = project.registeredSeconds
      const pending = project.pendingSeconds
      summary.registered += registered
      summary.pending += pending
      summary.tracked += registered + pending
    } else {
      summary.outside += project.totalSeconds
    }
  }
  return summary
}

export function jiraShare(registered: number, tracked: number): string {
  return tracked > 0 ? `${Math.floor((registered / tracked) * 100)} %` : '—'
}

export function jiraStatus(project: ReportProject): { text: string; pending: boolean; outside: boolean } {
  if (project.jira !== true) return { text: 'sin Jira', pending: false, outside: true }
  if (project.pendingSeconds > 0) return { text: `${hours(project.pendingSeconds)} pendientes`, pending: true, outside: false }
  return { text: 'en Jira', pending: false, outside: false }
}

export function isMeeting(entry: ReportEntry): boolean {
  return entry.kind === 'meeting' || entry.kind === 'remote-meeting' || entry.kind === 'in-person-meeting'
}

export interface Bucket {
  key: string
  label: string
  tip: string
  seconds: number
  weekend: boolean
  projects: ProjectSeconds[]
}

export function dayBuckets(report: ReportView): Bucket[] {
  return report.days.map((day) => ({
    key: day.day,
    label: dayOfMonth(day.day),
    tip: dayLabel(day.day),
    seconds: day.totalSeconds,
    weekend: isWeekend(day.day),
    projects: day.projects,
  }))
}

export function weekBuckets(report: ReportView): Bucket[] {
  return report.weeks.map((week) => ({
    key: week.fromDay,
    label: shortRange(week.fromDay, week.toDay),
    tip: shortRange(week.fromDay, week.toDay),
    seconds: week.totalSeconds,
    weekend: false,
    projects: week.projects,
  }))
}

export function monthBuckets(report: ReportView): Bucket[] {
  const months = new Map<string, Bucket>()
  for (const day of report.days) {
    const key = day.day.slice(0, 7)
    const bucket = months.get(key) ?? {
      key,
      label: monthLabel(key),
      tip: monthLabel(key),
      seconds: 0,
      weekend: false,
      projects: [],
    }
    bucket.seconds += day.totalSeconds
    for (const slice of day.projects) {
      const found = bucket.projects.find((item) => item.projectId === slice.projectId)
      if (found === undefined) bucket.projects.push({ ...slice })
      else found.seconds += slice.seconds
    }
    months.set(key, bucket)
  }
  return [...months.values()]
}

export function overlapFor(report: ReportView, day: string): number {
  return report.overlaps.find((item) => item.localDay === day)?.overlapSeconds ?? 0
}

export function entryStart(entry: ReportEntry): string {
  const date = new Date(entry.start)
  if (Number.isNaN(date.getTime())) return entry.start
  const day = String(date.getDate()).padStart(2, '0')
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${day} ${MONTHS[date.getMonth()] ?? ''} ${time}`
}

export function summaryText(report: ReportView, preset: PresetId | null): string {
  const lines = [
    `Tiempo por proyecto · ${rangeLabel(report.range.fromDay, report.range.toDay)}${preset === null ? '' : ` · ${presetPhrase(preset)}`}`,
    `${hours(report.totalSeconds)} en ${plural(report.activeDays, 'día', 'días')} · ${plural(report.entryCount, 'entrada', 'entradas')} · ${plural(report.projects.length, 'proyecto', 'proyectos')}`,
    '',
  ]
  for (const project of report.projects) {
    lines.push(`- ${projectLabel(project)}: ${hours(project.totalSeconds)} (${percent(project.totalSeconds, report.totalSeconds)})`)
  }
  return lines.join('\n')
}

export function money(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es-MX', { style: 'currency', currency }).format(amount)
  } catch {
    return `${amount.toFixed(2)} ${currency}`
  }
}

export function multiplierLabel(multiplier: number): string {
  return `×${Number(multiplier.toFixed(2))}`
}

export function overtimeTotals(overtime: Overtime): OvertimeTotals {
  if (overtime.totals !== undefined && overtime.totals !== null) return overtime.totals
  const zero: OvertimeTotals = { estimateSeconds: 0, expectedSeconds: 0, overtimeSeconds: 0, payX1: 0, payMultiplied: 0 }
  return overtime.months.reduce(
    (sum, month) => ({
      estimateSeconds: sum.estimateSeconds + month.estimateSeconds,
      expectedSeconds: sum.expectedSeconds + month.expectedSeconds,
      overtimeSeconds: sum.overtimeSeconds + month.overtimeSeconds,
      payX1: sum.payX1 + month.payX1,
      payMultiplied: sum.payMultiplied + month.payMultiplied,
    }),
    zero,
  )
}
