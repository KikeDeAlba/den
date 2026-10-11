import { copyText, describeProblem, exportPdf } from '../bita.ts'
import { element, icon } from '../dom.ts'
import type { App, Destination, ExportState } from './app.ts'
import { dateField, overtimeCurrency } from './dashboard.ts'
import { colorMap, filterReport, OTHERS_COLOR, plural, presetChoice, projectKey, projectLabel, summaryText, type PresetId } from './model.ts'
import { paper, type PaperOptions } from './paper.ts'
import { exportReport, type ExportFormat, type ExportInclude, type GroupBy, type ReportView } from './types.ts'
import { button, loading, problemState, segmented } from './ui.ts'

const PILL_LIMIT = 5

const FORMATS: { id: ExportFormat; name: string; hint: string; extension: string }[] = [
  { id: 'pdf', name: 'PDF', hint: 'Reporte con gráficas y tablas, listo para mandar', extension: 'pdf' },
  { id: 'csv', name: 'CSV', hint: 'Una fila por entrada, para hojas de cálculo', extension: 'csv' },
  { id: 'xlsx', name: 'Excel', hint: 'Hojas por proyecto, por día y entradas', extension: 'xlsx' },
  { id: 'md', name: 'Markdown', hint: 'Página para inkwell o Confluence', extension: 'md' },
]

const SECTIONS: { id: keyof ExportInclude | 'notes'; name: string; hint: string }[] = [
  { id: 'charts', name: 'Gráficas', hint: 'horas por día, por semana y distribución' },
  { id: 'projects', name: 'Tabla por proyecto', hint: 'horas, porcentaje, entradas y promedio' },
  { id: 'entries', name: 'Detalle de entradas', hint: 'título, inicio y duración de cada una' },
  { id: 'jira', name: 'Estado en Jira', hint: 'issue y worklogs registrados por tally' },
  { id: 'pay', name: 'Incluir pago', hint: 'horas extra y montos por mes' },
  { id: 'notes', name: 'Notas de inkwell', hint: 'Den todavía no las exporta' },
]

export function exportView(app: App, reload: () => void): HTMLElement {
  const page = element('div', 'report-export')
  const state = app.exporting
  if (state === null) return page
  page.append(form(app, state, reload), preview(app, state, reload))
  return page
}

function chosenReport(state: ExportState): ReportView | null {
  if (state.report === null) return null
  return filterReport(state.report, new Set(state.report.projects.map((project) => projectKey(project.projectId)).filter((key) => !picked(state, key))))
}

function picked(state: ExportState, key: string): boolean {
  return state.only === null ? !state.excluded.has(key) : state.only.has(key)
}

function fieldset(legend: string, className = ''): HTMLFieldSetElement {
  const node = element('fieldset', `report-fieldset ${className}`.trim()) as HTMLFieldSetElement
  node.append(element('legend', 'report-legend-title', legend))
  return node
}

function form(app: App, state: ExportState, reload: () => void): HTMLElement {
  const node = element('form', 'report-export-form') as HTMLFormElement
  node.setAttribute('aria-label', 'Opciones de exportación')
  node.addEventListener('submit', (event) => {
    event.preventDefault()
    void run(app, state)
  })

  const head = element('div', 'report-export-head')
  const back = element('button', 'report-back') as HTMLButtonElement
  back.type = 'button'
  back.dataset['key'] = 'export-back'
  back.setAttribute('aria-label', 'Volver')
  back.append(icon('prev', 13))
  back.disabled = state.busy
  back.addEventListener('click', () => app.navigate({ name: 'dashboard' }))
  head.append(back, element('h1', 'report-export-title', 'Exportar reporte'))
  node.append(head)

  const formats = fieldset('Formato')
  const grid = element('div', 'report-formats')
  for (const format of FORMATS) {
    const label = element('label', format.id === state.format ? 'report-format report-format--on' : 'report-format') as HTMLLabelElement
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'format'
    radio.value = format.id
    radio.checked = format.id === state.format
    radio.dataset['key'] = `format-${format.id}`
    radio.addEventListener('change', () => {
      state.format = format.id
      state.status = null
      app.render()
    })
    const text = element('span', 'report-format-text')
    text.append(element('span', 'report-format-name', format.name), element('span', 'report-format-hint', format.hint))
    label.append(radio, text)
    grid.append(label)
  }
  formats.append(grid)
  node.append(formats)

  const range = fieldset('Rango')
  const shown: PresetId = state.choice.preset === 'quarter' ? 'custom' : state.choice.preset
  range.append(
    segmented<PresetId>(
      'Rango',
      [
        { id: 'week', label: 'Semana' },
        { id: 'month', label: 'Mes' },
        { id: '30d', label: '30 días' },
        { id: 'custom', label: 'Otro' },
      ],
      shown,
      (id) => {
        state.choice = presetChoice(id, app.today, state.choice)
        reload()
      },
      'export-range',
    ),
  )
  const dates = element('div', 'report-dates')
  const from = dateField('Desde', state.choice.from, 'export-from')
  const to = dateField('Hasta', state.choice.to, 'export-to')
  const onDate = (): void => {
    const start = from.input.value
    const end = to.input.value
    if (start === '' || end === '') return
    state.choice = { preset: 'custom', from: start <= end ? start : end, to: start <= end ? end : start }
    reload()
  }
  from.input.addEventListener('change', onDate)
  to.input.addEventListener('change', onDate)
  dates.append(from.label, to.label)
  range.append(dates)
  node.append(range)

  node.append(projectsField(app, state))

  const grouping = fieldset('Agrupar por')
  grouping.append(
    segmented<GroupBy>(
      'Agrupar por',
      [
        { id: 'project', label: 'Proyecto' },
        { id: 'day', label: 'Día' },
        { id: 'week', label: 'Semana' },
      ],
      state.groupBy,
      (id) => {
        state.groupBy = id
        app.render()
      },
      'export-group',
    ),
  )
  node.append(grouping)

  const include = fieldset('Incluir', 'report-fieldset--tight')
  const jiraAvailable = state.report?.jiraAvailable ?? app.main.report?.jiraAvailable ?? false
  const payAvailable = hasOvertime(state)
  for (const section of SECTIONS) {
    const disabled = section.id === 'notes' || (section.id === 'jira' && !jiraAvailable) || (section.id === 'pay' && !payAvailable)
    const row = element('div', 'report-switch-row')
    const text = element('span', 'report-switch-text')
    const jiraProblem = state.report?.jiraProblem ?? null
    const hint =
      section.id === 'jira' && !jiraAvailable
        ? (jiraProblem ?? 'necesita tally 0.3 con status')
        : section.id === 'pay' && !payAvailable
          ? 'configura tu pago en el reporte para incluirlo'
          : section.hint
    text.append(element('span', 'report-switch-name', section.name), element('span', 'report-switch-hint', hint))
    const toggle = element('button', 'switch') as HTMLButtonElement
    toggle.type = 'button'
    toggle.setAttribute('role', 'switch')
    toggle.setAttribute('aria-label', section.name)
    const id = section.id
    const on = id !== 'notes' && state.include[id] && !disabled
    toggle.setAttribute('aria-checked', String(on))
    toggle.disabled = disabled
    toggle.dataset['key'] = `include-${section.id}`
    toggle.append(element('span', 'switch-knob'))
    toggle.addEventListener('click', () => {
      if (id === 'notes') return
      state.include[id] = !state.include[id]
      app.render()
    })
    row.append(text, toggle)
    include.append(row)
  }
  node.append(include)

  const target = fieldset('Destino')
  const extension = FORMATS.find((format) => format.id === state.format)?.extension ?? 'pdf'
  const targets: { id: Destination; name: string; note: string; disabled: boolean }[] = [
    { id: 'downloads', name: 'Guardar en Descargas', note: `~/Downloads/${fileBase(state)}.${extension}`, disabled: false },
    { id: 'clipboard', name: 'Copiar al portapapeles', note: 'resumen en texto', disabled: false },
    { id: 'inkwell', name: 'Publicar en inkwell', note: 'como página del espacio · aún no disponible', disabled: true },
  ]
  for (const item of targets) {
    const label = element('label', item.disabled ? 'report-target report-target--off' : 'report-target') as HTMLLabelElement
    const radio = document.createElement('input')
    radio.type = 'radio'
    radio.name = 'target'
    radio.value = item.id
    radio.checked = item.id === state.destination
    radio.disabled = item.disabled
    radio.dataset['key'] = `target-${item.id}`
    radio.addEventListener('change', () => {
      state.destination = item.id
      state.status = null
      app.render()
    })
    label.append(radio, element('span', undefined, item.name), element('span', 'report-target-note', item.note))
    target.append(label)
  }
  node.append(target)

  const actions = element('div', 'report-export-actions')
  if (state.status !== null) {
    const status = element('p', state.status.error ? 'report-export-status report-export-status--error' : 'report-export-status', state.status.text)
    status.setAttribute('role', state.status.error ? 'alert' : 'status')
    actions.append(status)
  }
  const cancel = button('Cancelar', 'ghost-button', () => app.navigate({ name: 'dashboard' }))
  cancel.dataset['key'] = 'export-cancel'
  cancel.disabled = state.busy
  const name = FORMATS.find((format) => format.id === state.format)?.name ?? 'PDF'
  const submit = element(
    'button',
    'primary-button',
    state.busy ? 'Exportando…' : state.destination === 'clipboard' ? 'Copiar resumen' : `Exportar ${name}`,
  ) as HTMLButtonElement
  submit.type = 'submit'
  submit.dataset['key'] = 'export-submit'
  const chosen = chosenReport(state)
  submit.disabled = state.busy || chosen === null || chosen.projects.length === 0 || state.loading
  actions.append(cancel, submit)
  node.append(actions)
  return node
}

function projectsField(app: App, state: ExportState): HTMLElement {
  const field = fieldset('Proyectos')
  const report = state.report
  if (report === null) {
    field.append(element('span', 'report-meta', state.loading ? 'Preguntando al CLI…' : 'Sin datos del rango'))
    return field
  }
  const colors = colorMap(report)
  const list = element('div', 'report-pills')
  const shown = state.expanded ? report.projects : report.projects.slice(0, PILL_LIMIT)
  for (const project of shown) {
    const key = projectKey(project.projectId)
    const on = picked(state, key)
    const toggle = element('button', on ? 'pill report-pill' : 'pill pill--empty report-pill') as HTMLButtonElement
    toggle.type = 'button'
    toggle.setAttribute('aria-pressed', String(on))
    toggle.dataset['key'] = `pick-${key}`
    const dot = element('i', 'dot')
    dot.style.background = on ? (colors.get(key) ?? OTHERS_COLOR) : 'var(--elev-strong)'
    toggle.append(dot, element('span', undefined, projectLabel(project)))
    toggle.addEventListener('click', () => {
      const target = state.only ?? state.excluded
      if (target.has(key)) target.delete(key)
      else target.add(key)
      state.status = null
      app.render()
    })
    list.append(toggle)
  }
  const hidden = report.projects.length - PILL_LIMIT
  if (hidden > 0) {
    const more = button(state.expanded ? 'mostrar menos' : `+ ${hidden} más`, 'pill pill--empty report-pill', () => {
      state.expanded = !state.expanded
      app.render()
    })
    more.dataset['key'] = 'pick-more'
    list.append(more)
  }
  field.append(list)
  const total = report.projects.length
  const count = report.projects.filter((project) => picked(state, projectKey(project.projectId))).length
  const caption = element('span', 'report-meta')
  if (total === 0) caption.textContent = 'No hay proyectos con tiempo en el rango'
  else if (count === total) caption.textContent = `Todos los proyectos con tiempo en el rango · ${total}`
  else if (count === 0) caption.textContent = 'Elige al menos un proyecto'
  else caption.textContent = `${count} de ${plural(total, 'proyecto', 'proyectos')}`
  field.append(caption)
  if (count !== total && total > 0) {
    const all = button('elegir todos', 'quiet-link', () => {
      state.only = null
      state.excluded.clear()
      app.render()
    })
    all.dataset['key'] = 'pick-all'
    field.append(all)
  }
  return field
}

function preview(app: App, state: ExportState, reload: () => void): HTMLElement {
  const section = element('section', 'report-preview')
  section.setAttribute('aria-label', 'Vista previa')
  const head = element('div', 'report-preview-head')
  const label = state.format === 'pdf' ? 'carta' : `${FORMATS.find((format) => format.id === state.format)?.name ?? ''} · mismo contenido`
  head.append(element('span', 'report-preview-label', 'Vista previa'), element('span', 'report-num report-num--mute', label))
  section.append(head)
  if (state.loading) {
    section.append(loading())
    return section
  }
  if (state.error !== null) {
    section.append(problemState(state.error, reload))
    return section
  }
  const report = chosenReport(state)
  if (report === null) {
    section.append(loading())
    return section
  }
  const colors = state.report === null ? new Map<string, string>() : colorMap(state.report)
  section.append(paper(report, paperOptions(app, state, colors)))
  return section
}

function hasOvertime(state: ExportState): boolean {
  const overtime = state.report?.overtime ?? null
  return overtime !== null && overtime.months.length > 0
}

function effectiveInclude(state: ExportState): ExportInclude {
  return { ...state.include, jira: state.include.jira && (state.report?.jiraAvailable ?? false), pay: state.include.pay && hasOvertime(state) }
}

function paperOptions(app: App, state: ExportState, colors: Map<string, string>): PaperOptions {
  const overtime = state.report?.overtime ?? null
  return {
    include: effectiveInclude(state),
    groupBy: state.groupBy,
    generated: app.today,
    colors,
    currency: overtime === null ? 'MXN' : overtimeCurrency(app, overtime),
  }
}

function fileBase(state: ExportState): string {
  const report = chosenReport(state)
  const day = report?.range.toDay ?? state.choice.to
  if (report !== null && report.projects.length === 1) {
    const slug = projectLabel(report.projects[0])
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    if (slug !== '') return `reporte-${slug}-${day}`
  }
  return `reporte-${day}`
}

async function run(app: App, state: ExportState): Promise<void> {
  const report = chosenReport(state)
  if (report === null || state.busy || report.projects.length === 0) return
  state.busy = true
  state.status = null
  app.render()
  try {
    if (state.destination === 'clipboard') {
      await copyText(summaryText(report, state.choice.preset))
      state.status = { text: 'Resumen copiado al portapapeles', error: false }
    } else if (state.format === 'pdf') {
      const path = await printPdf(app, state, report)
      state.status = { text: `Guardado en ${tilde(path)}`, error: false }
    } else {
      const include = effectiveInclude(state)
      const payload = include.pay ? report : { ...report, overtime: null }
      const path = await exportReport(state.format, payload, include, state.groupBy, fileBase(state))
      state.status = { text: `Guardado en ${tilde(path)}`, error: false }
    }
  } catch (error) {
    state.status = { text: describeProblem(error).message, error: true }
  } finally {
    state.busy = false
    app.render()
  }
}

async function printPdf(app: App, state: ExportState, report: ReportView): Promise<string> {
  const host = document.getElementById('reportes') ?? document.body
  document.getElementById('print-root')?.remove()
  const root = element('div', 'print-root')
  root.id = 'print-root'
  const colors = state.report === null ? new Map<string, string>() : colorMap(state.report)
  root.append(paper(report, paperOptions(app, state, colors)))
  host.append(root)
  try {
    document.body.classList.add('printing')
    return await exportPdf(fileBase(state))
  } finally {
    document.body.classList.remove('printing')
    root.remove()
  }
}

export function tilde(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, '~')
}
