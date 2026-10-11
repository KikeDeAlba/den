import { describeProblem, exportPdf } from '../bita.ts'
import { element } from '../dom.ts'
import type { App, CoworkerExportState, CoworkerState } from './app.ts'
import { tilde } from './export.ts'
import { dayLabel, hours, hourValue, money, monthLabel, multiplierLabel, plural } from './model.ts'
import {
  exportCoworkerReport,
  openJiraUrl,
  type CoworkerExportInclude,
  type CoworkerExportReport,
  type CoworkerIssue,
  type CoworkerOvertime,
  type CoworkerTotals,
  type ExportFormat,
} from './types.ts'
import { button, segmented } from './ui.ts'

const FORMATS: { id: ExportFormat; name: string; extension: string }[] = [
  { id: 'pdf', name: 'PDF', extension: 'pdf' },
  { id: 'csv', name: 'CSV', extension: 'csv' },
  { id: 'xlsx', name: 'Excel', extension: 'xlsx' },
  { id: 'md', name: 'Markdown', extension: 'md' },
]


export function coworkerExportState(): CoworkerExportState {
  return { open: false, format: 'pdf', pay: false, withoutEstimate: true, busy: false, status: null }
}

export function issueUrl(issue: CoworkerIssue): string | null {
  const url = issue.url ?? null
  return url !== null && url.startsWith('https://') && url.endsWith(`/browse/${issue.key}`) ? url : null
}

export function issueLink(issue: CoworkerIssue, className: string): HTMLElement {
  const url = issueUrl(issue)
  if (url === null) return element('span', undefined, issue.key)
  const link = element('a', className, issue.key) as HTMLAnchorElement
  link.href = url
  link.rel = 'noopener noreferrer'
  link.title = `Abrir ${issue.key} en Jira`
  link.dataset['key'] = `issue-${issue.key}`
  link.addEventListener('click', (event) => {
    event.preventDefault()
    openJiraUrl(url).catch(() => undefined)
  })
  return link
}

export function isPaid(overtime: CoworkerOvertime): boolean {
  const rate = overtime.rate.hourlyRate
  return rate !== null && Number.isFinite(rate) && rate > 0
}

function hasMissing(overtime: CoworkerOvertime): boolean {
  return overtime.months.some((month) => month.withoutEstimate.length > 0)
}

function effectiveInclude(overtime: CoworkerOvertime, exporting: CoworkerExportState): CoworkerExportInclude {
  return { pay: exporting.pay && isPaid(overtime), withoutEstimate: exporting.withoutEstimate && hasMissing(overtime) }
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function range(state: CoworkerState, overtime: CoworkerOvertime): { from: string; to: string } {
  if (state.range !== null) return state.range
  const first = overtime.months[0]?.month ?? ''
  const last = overtime.months[overtime.months.length - 1]?.month ?? first
  return { from: first, to: last }
}

export function coworkerFileBase(state: CoworkerState, overtime: CoworkerOvertime): string {
  const { from, to } = range(state, overtime)
  const person = slug(overtime.person.name) || 'companero'
  return ['horas-extra', person, from, to].filter((part) => part !== '').join('-')
}

function exportReport(state: CoworkerState, overtime: CoworkerOvertime): CoworkerExportReport {
  const { from, to } = range(state, overtime)
  return { ...overtime, fromMonth: from, toMonth: to }
}

function switchRow(name: string, hint: string, on: boolean, disabled: boolean, key: string, toggle: () => void): HTMLElement {
  const row = element('div', 'report-switch-row')
  const text = element('span', 'report-switch-text')
  text.append(element('span', 'report-switch-name', name), element('span', 'report-switch-hint', hint))
  const control = element('button', 'switch') as HTMLButtonElement
  control.type = 'button'
  control.setAttribute('role', 'switch')
  control.setAttribute('aria-label', name)
  control.setAttribute('aria-checked', String(on && !disabled))
  control.disabled = disabled
  control.dataset['key'] = key
  control.append(element('span', 'switch-knob'))
  control.addEventListener('click', toggle)
  row.append(text, control)
  return row
}

function refocus(app: App, key: string): void {
  app.render()
  document.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus()
}

export function exportPanel(app: App, state: CoworkerState, overtime: CoworkerOvertime): HTMLElement {
  const exporting = state.exporting
  const section = element('section', 'report-card coworker-export')
  section.setAttribute('aria-label', 'Exportar reporte del compañero')
  const form = element('form', 'coworker-export-form') as HTMLFormElement
  form.noValidate = true
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void run(app, state, overtime)
  })
  form.append(element('h2', 'report-card-title', 'Exportar reporte'))

  const formats = element('div', 'coworker-export-field')
  formats.append(element('span', 'report-field-label', 'Formato'))
  formats.append(
    segmented<ExportFormat>(
      'Formato',
      FORMATS.map((format) => ({ id: format.id, label: format.name })),
      exporting.format,
      (id) => {
        exporting.format = id
        exporting.status = null
        refocus(app, `coworker-format-${id}`)
      },
      'coworker-format',
    ),
  )
  form.append(formats)

  const paid = isPaid(overtime)
  const missing = overtime.months.reduce((sum, month) => sum + month.withoutEstimate.length, 0)
  const include = element('div', 'coworker-export-switches')
  include.append(
    switchRow(
      'Incluir pago',
      paid ? 'montos por mes y tarifa por hora' : 'la consulta no llevó sueldo',
      exporting.pay,
      !paid,
      'coworker-include-pay',
      () => {
        exporting.pay = !exporting.pay
        exporting.status = null
        refocus(app, 'coworker-include-pay')
      },
    ),
    switchRow(
      'Incluir tarjetas sin estimación',
      missing > 0 ? `${plural(missing, 'tarjeta', 'tarjetas')} · no suman horas` : 'no hay tarjetas sin estimación',
      exporting.withoutEstimate,
      missing === 0,
      'coworker-include-missing',
      () => {
        exporting.withoutEstimate = !exporting.withoutEstimate
        exporting.status = null
        refocus(app, 'coworker-include-missing')
      },
    ),
  )
  form.append(include)

  const format = FORMATS.find((item) => item.id === exporting.format) ?? { id: 'pdf', name: 'PDF', extension: 'pdf' }
  const target = element('p', 'report-meta coworker-export-target', `~/Downloads/${coworkerFileBase(state, overtime)}.${format.extension}`)
  form.append(target)

  const actions = element('div', 'coworker-actions')
  if (exporting.status !== null) {
    const status = element(
      'p',
      exporting.status.error ? 'report-export-status report-export-status--error coworker-status' : 'report-export-status coworker-status',
      exporting.status.text,
    )
    status.setAttribute('role', exporting.status.error ? 'alert' : 'status')
    actions.append(status)
  }
  const cancel = button('Cerrar', 'ghost-button', () => {
    exporting.open = false
    exporting.status = null
    refocus(app, 'coworker-export-open')
  })
  cancel.dataset['key'] = 'coworker-export-close'
  cancel.disabled = exporting.busy
  const submit = element('button', 'primary-button', exporting.busy ? 'Exportando…' : `Exportar ${format.name}`) as HTMLButtonElement
  submit.type = 'submit'
  submit.dataset['key'] = 'coworker-export-submit'
  submit.disabled = exporting.busy
  actions.append(cancel, submit)
  form.append(actions)
  section.append(form)
  return section
}

async function run(app: App, state: CoworkerState, overtime: CoworkerOvertime): Promise<void> {
  const exporting = state.exporting
  if (exporting.busy) return
  exporting.busy = true
  exporting.status = null
  app.render()
  const include = effectiveInclude(overtime, exporting)
  const report = exportReport(state, overtime)
  const name = coworkerFileBase(state, overtime)
  try {
    const path = exporting.format === 'pdf' ? await printPdf(report, include, app.today, name) : await exportCoworkerReport(exporting.format, report, include, name)
    if (state.result === overtime) exporting.status = { text: `Guardado en ${tilde(path)}`, error: false }
  } catch (error) {
    if (state.result === overtime) exporting.status = { text: describeProblem(error).message, error: true }
  } finally {
    exporting.busy = false
    if (app.view.name === 'coworkers') app.render()
  }
}

async function printPdf(report: CoworkerExportReport, include: CoworkerExportInclude, today: string, name: string): Promise<string> {
  const host = document.getElementById('reportes') ?? document.body
  document.getElementById('print-root')?.remove()
  const root = element('div', 'print-root')
  root.id = 'print-root'
  root.append(coworkerPaper(report, include, today))
  host.append(root)
  try {
    document.body.classList.add('printing')
    return await exportPdf(name)
  } finally {
    document.body.classList.remove('printing')
    root.remove()
  }
}

function block(title: string): HTMLElement {
  const section = element('section', 'paper-block')
  section.append(element('div', 'paper-label', title))
  return section
}

function table(headers: [string, boolean][]): { table: HTMLElement; body: HTMLElement } {
  const node = element('table', 'paper-table')
  const head = element('thead')
  const row = element('tr')
  for (const [label, right] of headers) {
    const th = element('th', right ? 'paper-right' : undefined, label)
    th.setAttribute('scope', 'col')
    row.append(th)
  }
  head.append(row)
  const body = element('tbody')
  node.append(head, body)
  return { table: node, body }
}

function cell(text: string, className?: string): HTMLElement {
  return element('td', className, text)
}

function amountText(value: number | null, currency: string): string {
  return value === null ? '—' : money(value, currency)
}

function monthRange(report: CoworkerExportReport): string {
  if (report.fromMonth === '' && report.toMonth === '') return 'Sin meses'
  if (report.fromMonth === report.toMonth) return monthLabel(report.fromMonth)
  return `${monthLabel(report.fromMonth)} – ${monthLabel(report.toMonth)}`
}

function byStart(a: CoworkerIssue, b: CoworkerIssue): number {
  return (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.key.localeCompare(b.key)
}

function issuesBlock(title: string, issues: CoworkerIssue[], withEstimate: boolean, empty: string): HTMLElement {
  const section = block(title)
  if (issues.length === 0) {
    section.append(element('p', 'paper-empty', empty))
    return section
  }
  const headers: [string, boolean][] = [
    ['Clave', false],
    ['Título', false],
    ['Proyecto', false],
    ['Inicio', false],
  ]
  if (withEstimate) headers.push(['Horas', true])
  const built = table(headers)
  for (const issue of [...issues].sort(byStart)) {
    const row = element('tr')
    const key = element('td', 'paper-num paper-nowrap paper-strong')
    key.append(issueLink(issue, 'paper-link'))
    row.append(
      key,
      cell(issue.summary.trim() || 'Sin título', 'paper-strong'),
      cell(issue.project ?? '—', 'paper-nowrap'),
      cell(issue.startDate === null ? '—' : dayLabel(issue.startDate.slice(0, 10), true), 'paper-num paper-nowrap'),
    )
    if (withEstimate) row.append(cell(issue.estimateSeconds === null ? '—' : hourValue(issue.estimateSeconds), 'paper-right paper-num paper-strong'))
    built.body.append(row)
  }
  section.append(built.table)
  return section
}

export function coworkerPaper(report: CoworkerExportReport, include: CoworkerExportInclude, generated: string): HTMLElement {
  const sheet = element('article', 'paper coworker-paper')
  const pay = include.pay && isPaid(report)
  const currency = report.rate.currency
  const factor = multiplierLabel(report.rate.multiplier)
  const issues = report.months.flatMap((month) => month.issues)
  const missing = include.withoutEstimate ? report.months.flatMap((month) => month.withoutEstimate) : []
  const totals: CoworkerTotals = report.totals

  const header = element('header', 'paper-header')
  const left = element('div')
  left.append(element('div', 'paper-kicker', `Horas extra · ${report.person.name}`), element('h2', 'paper-title', monthRange(report)))
  const right = element('div', 'paper-meta')
  right.append(element('span', undefined, plural(issues.length, 'tarjeta terminada', 'tarjetas terminadas')), element('br'))
  right.append(element('span', undefined, `generado el ${dayLabel(generated, true)}`))
  header.append(left, right)
  sheet.append(header)

  const stats: [string, string][] = [
    [hours(totals.estimateSeconds), 'estimadas'],
    [hours(totals.expectedSeconds), 'esperadas'],
    [hours(totals.overtimeSeconds), 'extra'],
    pay ? [amountText(totals.payMultiplied, currency), `pago ${factor}`] : [String(issues.length), issues.length === 1 ? 'tarjeta' : 'tarjetas'],
  ]
  const grid = element('div', 'paper-stats')
  for (const [value, label] of stats) {
    const stat = element('div', 'paper-stat')
    stat.append(element('span', 'paper-stat-value', value), element('span', 'paper-stat-label', label))
    grid.append(stat)
  }
  sheet.append(grid)

  const months = block('Por mes')
  months.append(
    element(
      'p',
      'paper-note',
      pay
        ? `${report.rate.monthlyHours} h esperadas al mes · hora de ${money(report.rate.hourlyRate ?? 0, currency)}`
        : `${report.rate.monthlyHours} h esperadas al mes`,
    ),
  )
  if (report.months.length === 0) {
    months.append(element('p', 'paper-empty', 'Sin meses en el rango.'))
  } else {
    const headers: [string, boolean][] = [
      ['Mes', false],
      ['Estimadas', true],
      ['Esperadas', true],
      ['Extra', true],
    ]
    if (pay) headers.push(['Pago ×1', true], [`Pago ${factor}`, true])
    const built = table(headers)
    const line = (label: string, values: CoworkerTotals, className?: string): HTMLElement => {
      const row = element('tr', className)
      row.append(
        cell(label, 'paper-strong paper-nowrap'),
        cell(hourValue(values.estimateSeconds), 'paper-right paper-num'),
        cell(hourValue(values.expectedSeconds), 'paper-right paper-num'),
        cell(hourValue(values.overtimeSeconds), 'paper-right paper-num paper-strong'),
      )
      if (pay) {
        row.append(
          cell(amountText(values.payX1, currency), 'paper-right paper-num'),
          cell(amountText(values.payMultiplied, currency), 'paper-right paper-num paper-strong'),
        )
      }
      return row
    }
    for (const month of report.months) built.body.append(line(monthLabel(month.month), month))
    built.body.append(line('Total', totals, 'paper-total'))
    months.append(built.table)
  }
  sheet.append(months)
  sheet.append(issuesBlock('Tarjetas', issues, true, 'Sin tarjetas terminadas con estimación en esos meses.'))
  if (missing.length > 0) sheet.append(issuesBlock('Sin estimación · no suman horas', missing, false, ''))

  const footer = element('footer', 'paper-footer')
  footer.append(element('span', undefined, 'Fuente: Jira vía tally'), element('span', undefined, 'Den'))
  sheet.append(footer)
  return sheet
}
