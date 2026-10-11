import { copyText, describeProblem } from '../bita.ts'
import { element, icon } from '../dom.ts'
import type { App, Grouping } from './app.ts'
import {
  colorMap,
  dayBuckets,
  hours,
  hourValue,
  jiraShare,
  jiraStatus,
  jiraSummary,
  LONG_DAY_HOURS,
  monthBuckets,
  monthLabel,
  money,
  multiplierLabel,
  overtimeTotals,
  OTHERS_COLOR,
  overlapFor,
  percent,
  plural,
  PRESETS,
  presetPhrase,
  projectKey,
  projectLabel,
  rangeLabel,
  summaryText,
  TOP_COLORED,
  weekBuckets,
  filterReport,
  type Bucket,
} from './model.ts'
import type { Overtime, ReportProject, ReportView } from './types.ts'
import {
  barRows,
  button,
  card,
  columnChart,
  emptyState,
  kpis,
  legendItem,
  loading,
  markIcon,
  notice,
  pill,
  primaryAction,
  problemState,
  segmented,
  stackedChart,
  swatch,
  type Kpi,
  type Segment,
  type Stack,
} from './ui.ts'

const RAIL_LIMIT = 10
const TABLE_LIMIT = 10
const DISTRIBUTION_LIMIT = 8

export function dashboard(app: App): HTMLElement {
  const page = element('div', 'report-dashboard')
  page.append(rail(app), main(app))
  return page
}

function rail(app: App): HTMLElement {
  const aside = element('aside', 'report-rail')
  const head = element('div', 'report-rail-head')
  head.setAttribute('data-tauri-drag-region', '')
  const mark = element('span', 'report-rail-mark')
  mark.append(markIcon())
  head.append(mark, element('span', 'report-rail-word', 'Den'), element('span', 'report-rail-sub', '· reportes'))
  aside.append(head)

  const nav = element('nav', 'report-rail-group')
  nav.setAttribute('aria-label', 'Rango')
  nav.append(element('div', 'report-rail-label', 'Rango'))
  for (const preset of PRESETS) {
    const item = button(preset.label, 'report-rail-item', () => app.selectPreset(preset.id))
    item.dataset['key'] = `preset-${preset.id}`
    if (preset.id === app.choice.preset) item.setAttribute('aria-current', 'true')
    nav.append(item)
  }
  if (app.choice.preset === 'custom') nav.append(customRange(app))
  aside.append(nav)

  const report = app.main.report
  if (report !== null && report.projects.length > 0) aside.append(projectFilter(app, report))
  return aside
}

function customRange(app: App): HTMLElement {
  const form = element('form', 'report-custom')
  form.setAttribute('aria-label', 'Rango personalizado')
  const from = dateField('Desde', app.choice.from, 'custom-from')
  const to = dateField('Hasta', app.choice.to, 'custom-to')
  const apply = element('button', 'ghost-button report-custom-apply', 'Ver rango') as HTMLButtonElement
  apply.type = 'submit'
  form.append(from.label, to.label, apply)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const start = from.input.value
    const end = to.input.value
    if (start === '' || end === '') return
    app.applyRange({ preset: 'custom', from: start <= end ? start : end, to: start <= end ? end : start })
  })
  return form
}

export function dateField(label: string, value: string, key: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const wrap = element('label', 'report-field') as HTMLLabelElement
  const input = document.createElement('input')
  input.type = 'date'
  input.value = value
  input.className = 'report-input'
  input.dataset['key'] = key
  wrap.append(element('span', 'report-field-label', label), input)
  return { label: wrap, input }
}

function projectFilter(app: App, report: ReportView): HTMLElement {
  const group = element('div', 'report-rail-group')
  const head = element('div', 'report-rail-label report-rail-label--split')
  head.append(element('span', undefined, 'Proyectos'), element('span', 'report-rail-count', String(report.projects.length)))
  group.append(head)
  const colors = colorMap(report)
  const shown = app.railExpanded ? report.projects : report.projects.slice(0, RAIL_LIMIT)
  for (const project of shown) {
    const key = projectKey(project.projectId)
    const row = element('label', 'report-rail-project') as HTMLLabelElement
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = !app.excluded.has(key)
    box.dataset['key'] = `filter-${key}`
    box.addEventListener('change', () => {
      if (box.checked) app.excluded.delete(key)
      else app.excluded.add(key)
      app.render()
    })
    const name = element('span', 'report-rail-name', projectLabel(project))
    name.title = projectLabel(project)
    row.append(box, swatch(colors.get(key) ?? OTHERS_COLOR, 'report-rail-dot'), name, element('span', 'report-num report-num--mute', hourValue(project.totalSeconds)))
    group.append(row)
  }
  const hidden = report.projects.length - RAIL_LIMIT
  if (hidden > 0) {
    const more = button(app.railExpanded ? 'Mostrar menos' : `${plural(hidden, 'proyecto más', 'proyectos más')}`, 'quiet-link report-rail-more', () => {
      app.railExpanded = !app.railExpanded
      app.render()
    })
    more.dataset['key'] = 'rail-more'
    group.append(more)
  }
  if (app.excluded.size > 0) {
    const all = button('Marcar todos', 'quiet-link report-rail-more', () => {
      app.excluded.clear()
      app.render()
    })
    all.dataset['key'] = 'rail-all'
    group.append(all)
  }
  return group
}

function main(app: App): HTMLElement {
  const section = element('main', 'report-main')
  const full = app.main.report
  const report = full === null ? null : filterReport(full, app.excluded)

  const header = element('header', 'report-header')
  const titles = element('div', 'report-titles')
  titles.append(element('h1', 'report-title', 'Tiempo por proyecto'))
  const sub = report === null ? presetPhrase(app.choice.preset) : subtitle(report, app)
  titles.append(element('p', 'report-subtitle', sub))
  header.append(titles)
  if (report !== null && report.totalSeconds > 0 && !app.main.loading) {
    header.append(
      segmented<Grouping>(
        'Agrupar las horas',
        [
          { id: 'day', label: 'Día' },
          { id: 'week', label: 'Semana' },
          { id: 'month', label: 'Mes' },
        ],
        app.grouping,
        (id) => {
          app.grouping = id
          app.render()
        },
        'grouping',
      ),
    )
    const copy = button(app.copied ? 'Copiado' : 'Copiar resumen', 'ghost-button', () => {
      copyText(summaryText(report, app.shownPreset))
        .then(() => {
          app.copied = true
          app.render()
          window.setTimeout(() => {
            app.copied = false
            app.render()
          }, 1400)
        })
        .catch((error: unknown) => {
          copy.textContent = describeProblem(error).message
        })
    })
    copy.dataset['key'] = 'copy'
    const exportButton = primaryAction('Exportar', () => app.openExport(null))
    exportButton.dataset['key'] = 'export'
    header.append(payButton(app), coworkersButton(app), copy, exportButton)
  } else {
    header.append(payButton(app), coworkersButton(app))
  }
  section.append(header)

  if (app.main.loading) {
    section.append(loading())
    return section
  }
  if (app.main.error !== null) {
    section.append(problemState(app.main.error, () => app.reload()))
    return section
  }
  if (full === null || report === null) {
    section.append(loading())
    return section
  }
  if (full.totalSeconds <= 0) {
    section.append(emptyState('No hay tiempo medido en este rango', 'Prueba con otro rango o arranca un cronómetro desde el panel.'))
    return section
  }
  if (report.projects.length === 0) {
    section.append(emptyState('Ningún proyecto seleccionado', 'Marca al menos uno en la lista de proyectos.'))
    return section
  }

  const colors = colorMap(report)
  if (full.jiraProblem !== null) section.append(notice(full.jiraProblem))
  section.append(summary(report))
  const overtime = full.overtime ?? null
  if (overtime !== null) section.append(overtimeCard(overtime, overtimeCurrency(app, overtime)))
  else if (app.pay.settings !== null && app.pay.settings.monthlySalary === null) section.append(payBanner(app))
  section.append(hoursChart(app, report))
  const pair = element('div', 'report-pair')
  pair.append(weeklyChart(report, colors), distribution(report, colors))
  section.append(pair)
  section.append(projectTable(app, report, colors, full))
  return section
}

function payButton(app: App): HTMLButtonElement {
  const node = button('Pago', 'ghost-button', () => app.openPay())
  node.dataset['key'] = 'pay-open'
  node.setAttribute('aria-haspopup', 'dialog')
  node.setAttribute('aria-label', 'Configurar pago y horas extra')
  return node
}

function coworkersButton(app: App): HTMLButtonElement {
  const node = button('Compañeros', 'ghost-button', () => app.openCoworkers())
  node.dataset['key'] = 'coworkers-open'
  node.setAttribute('aria-label', 'Horas extra de compañeros')
  return node
}

function payBanner(app: App): HTMLElement {
  const box = element('div', 'banner banner--quiet report-pay-banner')
  box.setAttribute('role', 'status')
  const setup = button('Configurar pago', 'quiet-link', () => app.openPay())
  setup.dataset['key'] = 'pay-setup'
  box.append(icon('clock', 13), element('span', 'banner-text report-grow', 'Configura tu pago para ver horas extra'), setup)
  return box
}

export function overtimeCurrency(app: App, overtime: Overtime): string {
  return overtime.currency ?? app.pay.settings?.currency ?? 'MXN'
}

function overtimeCard(overtime: Overtime, currency: string): HTMLElement {
  const section = element('section', 'report-card report-table-card report-overtime')
  section.setAttribute('aria-label', 'Horas extra')
  const head = element('div', 'report-table-head')
  const factor = multiplierLabel(overtime.multiplier)
  head.append(
    element('h2', 'report-card-title report-grow', 'Horas extra'),
    element('span', 'report-meta', `tu hora ${money(overtime.hourlyRate, currency)} · sobre el tiempo estimado`),
  )
  section.append(head)
  const problem = overtime.problem ?? null
  if (problem !== null && problem !== '') section.append(notice(problem))
  if (overtime.months.length === 0) {
    if (problem === null || problem === '') section.append(element('p', 'report-meta report-overtime-empty', 'Sin meses que calcular en este rango'))
    return section
  }

  const scroll = element('div', 'report-table-scroll')
  const table = element('table', 'report-table report-overtime-table')
  const caption = element('caption', 'report-sr', `Horas extra por mes, pago ×1 y ${factor}`)
  const thead = element('thead')
  const headRow = element('tr')
  const columns: [string, string][] = [
    ['Mes', ''],
    ['Estimadas', 'report-right'],
    ['Esperadas', 'report-right'],
    ['Extra', 'report-right'],
    ['Pago ×1', 'report-right'],
    [`Pago ${factor}`, 'report-right'],
  ]
  for (const [label, className] of columns) {
    const th = element('th', className, label)
    th.setAttribute('scope', 'col')
    headRow.append(th)
  }
  thead.append(headRow)
  const body = element('tbody')
  for (const month of overtime.months) {
    const row = element('tr')
    const name = element('th', 'report-overtime-month')
    name.setAttribute('scope', 'row')
    name.append(element('span', undefined, monthLabel(month.month)))
    if (month.partial) name.append(element('span', 'tag report-tag--pending', 'en curso'))
    const extra = month.overtimeSeconds > 0
    row.append(
      name,
      element('td', 'report-right report-num', hours(month.estimateSeconds)),
      element('td', 'report-right report-num report-num--dim', hours(month.expectedSeconds)),
      element('td', `report-right report-num ${extra ? 'report-num--strong' : 'report-num--dim'}`, hours(month.overtimeSeconds)),
      element('td', 'report-right report-num', money(month.payX1, currency)),
      element('td', `report-right report-num ${extra ? 'report-num--strong' : ''}`.trim(), money(month.payMultiplied, currency)),
    )
    body.append(row)
  }
  const totals = overtimeTotals(overtime)
  const foot = element('tfoot')
  const total = element('tr', 'report-overtime-total')
  const label = element('th', undefined, 'Total')
  label.setAttribute('scope', 'row')
  total.append(
    label,
    element('td', 'report-right report-num', hours(totals.estimateSeconds)),
    element('td', 'report-right report-num report-num--dim', hours(totals.expectedSeconds)),
    element('td', 'report-right report-num report-num--strong', hours(totals.overtimeSeconds)),
    element('td', 'report-right report-num report-num--strong', money(totals.payX1, currency)),
    element('td', 'report-right report-num report-num--strong', money(totals.payMultiplied, currency)),
  )
  foot.append(total)
  table.append(caption, thead, body, foot)
  scroll.append(table)
  section.append(scroll)
  return section
}

function subtitle(report: ReportView, app: App): string {
  return [
    rangeLabel(report.range.fromDay, report.range.toDay),
    presetPhrase(app.shownPreset),
    plural(report.entryCount, 'entrada de bita', 'entradas de bita'),
  ].join(' · ')
}

function summary(report: ReportView): HTMLElement {
  const average = report.activeDays > 0 ? report.totalSeconds / report.activeDays : 0
  const items: Kpi[] = [
    {
      label: 'Horas medidas',
      value: hours(report.totalSeconds),
      note: `en ${report.activeDays} de ${plural(report.days.length, 'día', 'días')}`,
    },
    { label: 'Promedio por día', value: hours(average), note: 'días con registro · meta 8 h' },
    { label: 'Proyectos activos', value: String(report.projects.length), note: concentration(report) },
  ]
  if (report.jiraAvailable) items.push(jiraKpi(report.projects))
  else {
    items.push({
      label: 'Entradas',
      value: String(report.entryCount),
      note: report.entryCount > 0 ? `${hours(report.totalSeconds / report.entryCount)} por entrada` : 'sin entradas',
    })
  }
  return kpis(items, 200)
}

function concentration(report: ReportView): string {
  const count = report.projects.length
  if (count === 1) return 'todo el tiempo en uno'
  if (count <= TOP_COLORED) return `${count} con tiempo en el rango`
  const top = report.projects.slice(0, TOP_COLORED).reduce((sum, project) => sum + project.totalSeconds, 0)
  return `${TOP_COLORED} concentran el ${Math.round((top / Math.max(report.totalSeconds, 1)) * 100)} % del tiempo`
}

export function jiraKpi(projects: ReportProject[]): Kpi {
  const jira = jiraSummary(projects)
  if (jira.tracked <= 0) {
    return { label: 'En Jira', value: '—', note: jira.outside > 0 ? `${hours(jira.outside)} sin Jira` : 'nada que registrar' }
  }
  const parts = [jira.pending > 0 ? `${hours(jira.pending)} pendientes` : 'nada pendiente']
  if (jira.outside > 0) parts.push(`${hours(jira.outside)} sin Jira`)
  return {
    label: 'En Jira',
    value: jiraShare(jira.registered, jira.tracked),
    note: parts.join(' · '),
    tone: jira.pending > 0 ? 'estimate' : 'ok',
  }
}

function hoursChart(app: App, report: ReportView): HTMLElement {
  const titles: Record<Grouping, string> = { day: 'Horas por día', week: 'Horas por semana', month: 'Horas por mes' }
  const section = card('report-hours', titles[app.grouping])
  const head = element('div', 'report-card-head')
  head.append(element('h2', 'report-card-title report-grow', titles[app.grouping]))
  const daily = app.grouping === 'day'
  const buckets: Bucket[] = daily ? dayBuckets(report) : app.grouping === 'week' ? weekBuckets(report) : monthBuckets(report)
  if (daily) {
    const goal = element('span', 'report-legend-note')
    goal.append(element('span', 'report-legend-goal'), element('span', undefined, '8 h'))
    head.append(goal)
    if (buckets.some((bucket) => bucket.seconds / 3600 > LONG_DAY_HOURS)) {
      const long = element('span', 'report-legend-note')
      long.append(swatch('var(--purple)'), element('span', undefined, 'más de 12 h: cronómetros simultáneos'))
      head.append(long)
    }
  }
  section.append(head)
  const dense = buckets.length > 31
  section.append(
    columnChart(titles[app.grouping], buckets.map((bucket) => ({ ...bucket, overlap: daily ? overlapFor(report, bucket.key) : 0 })), {
      height: 200,
      color: 'var(--blue)',
      goal: daily,
      highlight: daily,
      values: dense ? 'hide' : 'blank',
      minWidth: daily ? Math.max(720, buckets.length * 12) : 0,
      gap: dense ? 2 : daily ? 6 : 18,
      maxBar: daily ? 26 : 56,
    }),
  )
  return section
}

export function segmentsFor(report: ReportView, colors: Map<string, string>): { segments: Segment[]; others: Segment | null } {
  const top = report.projects.slice(0, TOP_COLORED)
  const segments = top.map((project) => {
    const key = projectKey(project.projectId)
    return { key, name: projectLabel(project), color: colors.get(key) ?? OTHERS_COLOR }
  })
  const rest = report.projects.length - top.length
  const others = rest > 0 ? { key: 'others', name: `Otros ${rest}`, color: OTHERS_COLOR } : null
  return { segments, others }
}

function weeklyChart(report: ReportView, colors: Map<string, string>): HTMLElement {
  const section = card('report-weeks', 'Por semana', 'Por semana y proyecto')
  const { segments, others } = segmentsFor(report, colors)
  const stacks: Stack[] = report.weeks.map((week) => {
    const parts = segments.map((segment) => ({
      segment,
      seconds: week.projects.filter((item) => projectKey(item.projectId) === segment.key).reduce((sum, item) => sum + item.seconds, 0),
    }))
    if (others !== null) {
      const known = parts.reduce((sum, part) => sum + part.seconds, 0)
      parts.push({ segment: others, seconds: Math.max(week.totalSeconds - known, 0) })
    }
    return {
      key: week.fromDay,
      label: weekBuckets({ ...report, weeks: [week] })[0]?.label ?? week.fromDay,
      seconds: week.totalSeconds,
      parts,
    }
  })
  section.append(stackedChart('Horas por semana y proyecto', stacks, 230))
  const legend = element('div', 'report-legend')
  for (const segment of others === null ? segments : [...segments, others]) legend.append(legendItem(segment.name, segment.color))
  section.append(legend)
  return section
}

function distribution(report: ReportView, colors: Map<string, string>): HTMLElement {
  const section = card('report-distribution', 'Distribución', 'Distribución')
  const top = report.projects.slice(0, DISTRIBUTION_LIMIT)
  const rows = top.map((project) => ({
    name: projectLabel(project),
    seconds: project.totalSeconds,
    color: colors.get(projectKey(project.projectId)) ?? OTHERS_COLOR,
  }))
  const rest = report.projects.slice(DISTRIBUTION_LIMIT)
  if (rest.length > 0) {
    rows.push({
      name: `Otros ${plural(rest.length, 'proyecto', 'proyectos')}`,
      seconds: rest.reduce((sum, project) => sum + project.totalSeconds, 0),
      color: OTHERS_COLOR,
    })
  }
  section.append(barRows(rows, report.totalSeconds))
  return section
}

function projectTable(app: App, report: ReportView, colors: Map<string, string>, full: ReportView): HTMLElement {
  const section = element('section', 'report-card report-table-card')
  section.setAttribute('aria-label', 'Proyectos')
  const head = element('div', 'report-table-head')
  head.append(element('h2', 'report-card-title report-grow', 'Proyectos'), element('span', 'report-meta', 'ordenado por horas'))
  section.append(head)

  const scroll = element('div', 'report-table-scroll')
  const table = element('table', 'report-table')
  const thead = element('thead')
  const headRow = element('tr')
  const columns: [string, string][] = [
    ['Proyecto', ''],
    ['Horas', 'report-right'],
    ['Del total', ''],
    ['Entradas', 'report-right'],
    ['Por entrada', 'report-right'],
  ]
  if (full.jiraAvailable) columns.push(['Jira', ''])
  for (const [label, className] of columns) {
    const th = element('th', className, label)
    th.setAttribute('scope', 'col')
    headRow.append(th)
  }
  thead.append(headRow)
  table.append(thead)

  const peak = report.projects[0]?.totalSeconds ?? 1
  const body = element('tbody')
  const shown = app.tableExpanded ? report.projects : report.projects.slice(0, TABLE_LIMIT)
  for (const project of shown) {
    const key = projectKey(project.projectId)
    const row = element('tr', 'report-row')
    const open = (): void => app.navigate({ name: 'detail', projectId: project.projectId })
    row.addEventListener('click', open)
    const nameCell = element('td')
    const link = element('button', 'report-row-link') as HTMLButtonElement
    link.type = 'button'
    link.dataset['key'] = `row-${key}`
    link.setAttribute('aria-label', `Ver el detalle de ${projectLabel(project)}`)
    link.append(pill(projectLabel(project), colors.get(key) ?? OTHERS_COLOR, project.projectId === null))
    link.addEventListener('click', (event) => {
      event.stopPropagation()
      open()
    })
    nameCell.append(link)

    const share = element('td')
    const meter = element('div', 'report-share')
    const track = element('div', 'report-share-track')
    const fill = element('div', 'report-share-fill')
    fill.style.width = `${((project.totalSeconds / Math.max(peak, 1)) * 100).toFixed(1)}%`
    fill.style.background = colors.get(key) ?? OTHERS_COLOR
    track.append(fill)
    meter.append(track, element('span', 'report-num report-num--mute', percent(project.totalSeconds, report.totalSeconds)))
    share.append(meter)

    row.append(
      nameCell,
      element('td', 'report-right report-num report-num--strong', hours(project.totalSeconds)),
      share,
      element('td', 'report-right report-num report-num--dim', String(project.entryCount)),
      element('td', 'report-right report-num report-num--dim', project.entryCount > 0 ? hours(project.totalSeconds / project.entryCount) : '—'),
    )
    if (full.jiraAvailable) {
      const cell = element('td')
      cell.append(jiraTag(project))
      row.append(cell)
    }
    body.append(row)
  }
  table.append(body)
  scroll.append(table)
  section.append(scroll)

  if (report.projects.length > TABLE_LIMIT) {
    const foot = element('div', 'report-table-foot')
    foot.append(
      element('span', undefined, app.tableExpanded ? `Mostrando ${report.projects.length} · ` : `Mostrando ${TABLE_LIMIT} de ${report.projects.length} · `),
    )
    const toggle = button(app.tableExpanded ? 'ver menos' : 'ver todos', 'quiet-link', () => {
      app.tableExpanded = !app.tableExpanded
      app.render()
    })
    toggle.dataset['key'] = 'table-more'
    foot.append(toggle)
    section.append(foot)
  }
  return section
}

export function jiraTag(project: ReportProject): HTMLElement {
  const status = jiraStatus(project)
  const className = status.outside ? 'tag tag--muted' : status.pending ? 'tag report-tag--pending' : 'tag'
  return element('span', className, status.text)
}
