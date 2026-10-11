import { invoke } from '@tauri-apps/api/core'

export interface ReportRange {
  fromDay: string
  toDay: string
  timezone: string | null
  weekStartsOn: number | string | null
}

export interface ReportProject {
  projectId: number | null
  name: string
  clientName: string | null
  totalSeconds: number
  entryCount: number
  color: string
  jira: boolean
  registeredSeconds: number
  pendingSeconds: number
}

export interface ProjectSeconds {
  projectId: number | null
  seconds: number
}

export interface ReportDay {
  day: string
  totalSeconds: number
  projects: ProjectSeconds[]
}

export interface ReportWeek {
  fromDay: string
  toDay: string
  totalSeconds: number
  projects: ProjectSeconds[]
}

export interface ReportOverlap {
  localDay: string
  trackedSeconds: number
  clockSeconds: number
  overlapSeconds: number
}

export interface ReportEntry {
  id: number
  title: string
  projectId: number | null
  start: string
  stop: string | null
  localDay: string
  seconds: number
  kind: string | null
  overlapping: boolean
  color: string
  registered: boolean | null
  issueKey: string | null
  jira: boolean | null
  excludedReason: string | null
  blockIds?: number[] | undefined
}

export interface JiraTotals {
  registeredSeconds: number
  pendingSeconds: number
  excludedSeconds: number
  nonJiraSeconds: number
}

export interface ReportView {
  range: ReportRange
  totalSeconds: number
  entryCount: number
  activeDays: number
  projects: ReportProject[]
  days: ReportDay[]
  weeks: ReportWeek[]
  overlaps: ReportOverlap[]
  entries: ReportEntry[] | null
  jiraAvailable: boolean
  jiraTotals: JiraTotals | null
  jiraProblem: string | null
  overtime?: Overtime | null | undefined
}

export interface OvertimeProject {
  projectId: number
  estimateSeconds: number
  counts: boolean
}

export interface OvertimeMonth {
  month: string
  partial: boolean
  estimateSeconds: number
  expectedSeconds: number
  overtimeSeconds: number
  payX1: number
  payMultiplied: number
  byProject?: OvertimeProject[] | undefined
}

export interface OvertimeTotals {
  estimateSeconds: number
  expectedSeconds: number
  overtimeSeconds: number
  payX1: number
  payMultiplied: number
}

export interface Overtime {
  hourlyRate: number
  multiplier: number
  currency?: string | undefined
  months: OvertimeMonth[]
  totals?: OvertimeTotals | null | undefined
  problem?: string | null | undefined
}

export interface PaySettings {
  monthlySalary: number | null
  currency: string
  monthlyHours: number
  multiplier: number
  excludedProjects: number[]
}

export const DEFAULT_PAY: PaySettings = {
  monthlySalary: null,
  currency: 'MXN',
  monthlyHours: 160,
  multiplier: 2,
  excludedProjects: [],
}

export type RangeQuery = { preset: 'week' | 'month' } | { from: string; to: string }

export type ExportFormat = 'pdf' | 'csv' | 'xlsx' | 'md'

export type FileFormat = Exclude<ExportFormat, 'pdf'>

export type GroupBy = 'project' | 'day' | 'week'

export interface ExportInclude {
  charts: boolean
  projects: boolean
  entries: boolean
  jira: boolean
  pay: boolean
}

export function fetchReport(range: RangeQuery, projectId: number | null, entries: boolean): Promise<ReportView> {
  const args: Record<string, unknown> = { ...range, entries }
  if (projectId !== null) args['projectId'] = projectId
  return invoke<ReportView>('report', args)
}

export function exportReport(
  format: FileFormat,
  report: ReportView,
  include: ExportInclude,
  groupBy: GroupBy,
  fileName: string,
): Promise<string> {
  return invoke<string>('export_report', { format, report, include, groupBy, fileName })
}

export async function getPay(): Promise<PaySettings> {
  const pay = await invoke<Partial<PaySettings> | null>('get_pay')
  return { ...DEFAULT_PAY, ...(pay ?? {}) }
}

export function setPay(pay: PaySettings): Promise<PaySettings | null> {
  return invoke<PaySettings | null>('set_pay', { pay })
}

export interface CoworkerQuery {
  user: string | null
  accountId: string | null
  fromMonth: string
  toMonth: string
  salary: number | null
  monthlyHours: number
  multiplier: number
  currency: string
  site: string | null
}

export interface CoworkerPerson {
  name: string
  accountId: string | null
  source: string | null
}

export interface CoworkerRate {
  hourlyRate: number | null
  monthlyHours: number
  multiplier: number
  currency: string
}

export interface CoworkerIssue {
  key: string
  summary: string
  project: string | null
  status: string | null
  startDate: string | null
  estimateSeconds: number | null
  url?: string | null | undefined
}

export interface CoworkerMonth {
  month: string
  estimateSeconds: number
  expectedSeconds: number
  overtimeSeconds: number
  payX1: number | null
  payMultiplied: number | null
  issues: CoworkerIssue[]
  withoutEstimate: CoworkerIssue[]
}

export interface CoworkerTotals {
  estimateSeconds: number
  expectedSeconds: number
  overtimeSeconds: number
  payX1: number | null
  payMultiplied: number | null
}

export interface CoworkerOvertime {
  person: CoworkerPerson
  rate: CoworkerRate
  months: CoworkerMonth[]
  totals: CoworkerTotals
  siteUrl?: string | null | undefined
}

export interface CoworkerExportInclude {
  pay: boolean
  withoutEstimate: boolean
}

export interface CoworkerExportReport extends CoworkerOvertime {
  fromMonth: string
  toMonth: string
}

export interface CoworkerCandidate {
  displayName: string
  email: string | null
  accountId: string
}

export type CoworkerOutcome = { status: 'ready'; overtime: CoworkerOvertime } | { status: 'ambiguous'; candidates: CoworkerCandidate[] }

export interface JiraSiteOption {
  site: string
  name?: string | null
}

export function fetchCoworkerOvertime(query: CoworkerQuery): Promise<CoworkerOutcome> {
  return invoke<CoworkerOutcome>('coworker_overtime', { query })
}

export function listOvertimeExcludes(): Promise<string[]> {
  return invoke<string[]>('overtime_excludes_list')
}

export function addOvertimeExclude(key: string): Promise<string[]> {
  return invoke<string[]>('overtime_excludes_add', { key })
}

export function removeOvertimeExclude(key: string): Promise<string[]> {
  return invoke<string[]>('overtime_excludes_remove', { key })
}

export function fetchJiraSites(): Promise<JiraSiteOption[]> {
  return invoke<JiraSiteOption[]>('atlassian_sites', { check: false })
}

export function exportCoworkerReport(
  format: FileFormat,
  report: CoworkerExportReport,
  include: CoworkerExportInclude,
  fileName: string,
): Promise<string> {
  return invoke<string>('export_coworker_report', { format, report, include, fileName })
}

export function openJiraUrl(url: string): Promise<void> {
  return invoke<void>('open_external', { url })
}
