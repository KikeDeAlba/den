import { describeProblem } from '../bita.ts'
import { element, icon } from '../dom.ts'
import type { App, CoworkerForm, CoworkerState, ExcludesState } from './app.ts'
import { coworkerExportState, exportPanel, issueLink } from './coworker-export.ts'
import { dayLabel, hours, money, monthLabel, multiplierLabel, plural } from './model.ts'
import {
  addOvertimeExclude,
  fetchCoworkerOvertime,
  fetchJiraSites,
  listOvertimeExcludes,
  removeOvertimeExclude,
  type CoworkerIssue,
  type CoworkerOvertime,
  type CoworkerQuery,
  type CoworkerTotals,
} from './types.ts'
import { button, card, emptyState, kpis, loading, notice, problemState } from './ui.ts'

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/
const KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,19}$/

export function coworkerState(today: string): CoworkerState {
  const month = today.slice(0, 7)
  return {
    form: { name: '', accountId: null, from: month, to: month, salary: '', hours: '160', multiplier: '2', currency: 'MXN', site: '' },
    loading: false,
    token: 0,
    error: null,
    invalid: null,
    stale: false,
    result: null,
    range: null,
    exporting: coworkerExportState(),
    candidates: null,
    sites: [],
    sitesLoaded: false,
    excludes: { keys: null, loading: false, error: null, draft: '', busy: false, status: null },
  }
}

export function clearSalaryField(state: CoworkerState): void {
  state.form.salary = ''
}

export function forgetSalary(state: CoworkerState): void {
  state.form.salary = ''
  state.stale = false
  state.token++
  state.loading = false
  state.result = null
  state.range = null
  state.exporting = coworkerExportState()
  state.candidates = null
  state.error = null
  state.invalid = null
}

export function prepareCoworkers(app: App): void {
  const state = app.coworkers
  if (state.excludes.keys === null && !state.excludes.loading) loadExcludes(app)
  if (!state.sitesLoaded) {
    state.sitesLoaded = true
    fetchJiraSites()
      .then((sites) => {
        state.sites = sites.filter((site) => siteValue(site) !== '')
        if (app.view.name === 'coworkers' && state.sites.length > 1) app.render()
      })
      .catch(() => {
        state.sites = []
        state.sitesLoaded = false
      })
  }
}

function siteValue(site: { site: string; name?: string | null }): string {
  return (site.name ?? site.site ?? '').trim()
}

export function parseAmount(text: string): number {
  const compact = text.replace(/[\s$]/g, '')
  if (compact === '') return Number.NaN
  const thousands = /^\d{1,3}(,\d{3})+(\.\d+)?$/.test(compact) || (compact.includes('.') && compact.includes(','))
  const clean = thousands ? compact.replace(/,/g, '') : compact.replace(',', '.')
  return /^\d+(\.\d+)?$/.test(clean) ? Number(clean) : Number.NaN
}

export function queryFrom(form: CoworkerForm): CoworkerQuery | string {
  const user = form.name.trim()
  if (form.accountId === null && user === '') return 'Escribe el nombre del compañero como aparece en Jira'
  if (form.accountId === null && user.startsWith('-')) return 'El nombre no puede empezar con guion'
  const from = form.from.trim()
  const to = form.to.trim()
  if (!MONTH_PATTERN.test(from) || !MONTH_PATTERN.test(to)) return 'Los meses van como AAAA-MM, por ejemplo 2026-10'
  if (from > to) return 'El mes de inicio debe ser anterior o igual al final'
  const salaryText = form.salary.trim()
  const salary = salaryText === '' ? null : parseAmount(salaryText)
  if (salary !== null && (!Number.isFinite(salary) || salary <= 0)) return 'El sueldo debe ser un número mayor que cero'
  const monthlyHours = parseAmount(form.hours)
  if (!Number.isFinite(monthlyHours) || monthlyHours < 1 || monthlyHours > 744) return 'Las horas al mes deben estar entre 1 y 744'
  const multiplier = parseAmount(form.multiplier)
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) return 'El multiplicador debe estar entre 1 y 10'
  const currency = form.currency.trim().toUpperCase()
  if (!/^[A-Z]{3}$/.test(currency)) return 'La moneda va en código de tres letras, como MXN'
  const site = form.site.trim()
  return {
    user: user === '' ? null : user,
    accountId: form.accountId,
    fromMonth: from,
    toMonth: to,
    salary,
    monthlyHours,
    multiplier,
    currency,
    site: site === '' ? null : site,
  }
}

function focus(key: string): void {
  document.querySelector<HTMLElement>(`[data-key="${key}"]`)?.focus()
}

function consult(app: App): void {
  const state = app.coworkers
  const query = queryFrom(state.form)
  if (typeof query === 'string') {
    state.invalid = query
    app.render()
    focus('coworker-submit')
    return
  }
  state.invalid = null
  state.stale = false
  state.error = null
  state.candidates = null
  state.result = null
  state.range = null
  state.exporting = coworkerExportState()
  state.loading = true
  const token = ++state.token
  app.render()
  fetchCoworkerOvertime(query)
    .then((outcome) => {
      if (token !== state.token) return
      if (outcome.status === 'ambiguous') state.candidates = outcome.candidates
      else {
        state.result = outcome.overtime
        state.range = { from: query.fromMonth, to: query.toMonth }
      }
    })
    .catch((error: unknown) => {
      if (token !== state.token) return
      state.error = error
    })
    .finally(() => {
      if (token !== state.token) return
      state.loading = false
      if (app.view.name === 'coworkers') app.render()
    })
}

function loadExcludes(app: App): void {
  const excludes = app.coworkers.excludes
  excludes.loading = true
  excludes.error = null
  listOvertimeExcludes()
    .then((keys) => {
      excludes.keys = keys
    })
    .catch((error: unknown) => {
      excludes.error = error
    })
    .finally(() => {
      excludes.loading = false
      if (app.view.name === 'coworkers') app.render()
    })
}

function changeExclude(app: App, action: () => Promise<string[]>, after: string, adding: boolean): void {
  const state = app.coworkers
  const excludes = state.excludes
  if (excludes.busy) return
  excludes.busy = true
  excludes.status = null
  app.render()
  action()
    .then((keys) => {
      excludes.keys = keys
      if (adding) excludes.draft = ''
      if (state.result !== null) state.stale = true
    })
    .catch((error: unknown) => {
      excludes.status = describeProblem(error).message
    })
    .finally(() => {
      excludes.busy = false
      if (app.view.name !== 'coworkers') return
      app.render()
      focus(after)
    })
}

export function coworkersView(app: App): HTMLElement {
  const state = app.coworkers
  const page = element('div', 'report-detail coworkers')

  const crumbs = element('nav', 'report-crumbs')
  crumbs.setAttribute('aria-label', 'Ruta')
  const back = element('button', 'report-crumb-back') as HTMLButtonElement
  back.type = 'button'
  back.dataset['key'] = 'coworkers-back'
  back.append(icon('prev', 12), element('span', undefined, 'Tiempo por proyecto'))
  back.addEventListener('click', () => app.navigate({ name: 'dashboard' }))
  crumbs.append(back, element('span', undefined, '/'), element('span', 'report-crumb-here', 'Compañeros'))
  page.append(crumbs)

  const header = element('header', 'report-header')
  const titles = element('div', 'report-titles')
  titles.append(
    element('h1', 'report-title', 'Horas extra de compañeros'),
    element('p', 'report-subtitle', 'Tarjetas terminadas y asignadas en Jira, por fecha de inicio · el sueldo no se guarda'),
  )
  header.append(titles)
  page.append(header)

  const pair = element('div', 'report-pair coworker-pair')
  pair.append(queryCard(app, state), excludesCard(app, state.excludes))
  page.append(pair)
  page.append(results(app, state))
  return page
}

function queryCard(app: App, state: CoworkerState): HTMLElement {
  const section = card('coworker-query', 'Consulta', 'Consulta')
  const form = element('form', 'coworker-form') as HTMLFormElement
  form.setAttribute('aria-label', 'Consultar horas extra de un compañero')
  form.noValidate = true
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    consult(app)
  })
  const draft = state.form
  const grid = element('div', 'coworker-grid')
  const field = (
    label: string,
    key: 'name' | 'from' | 'to' | 'salary' | 'hours' | 'multiplier' | 'currency',
    options: { placeholder: string; mode: 'decimal' | 'text' | 'numeric'; wide?: boolean; type?: string },
  ): void => {
    const wrap = element('label', options.wide === true ? 'report-field coworker-field--wide' : 'report-field') as HTMLLabelElement
    const input = document.createElement('input')
    input.type = options.type ?? 'text'
    input.inputMode = options.mode
    input.autocomplete = 'off'
    input.spellcheck = false
    input.className = 'report-input'
    input.value = draft[key]
    input.placeholder = options.placeholder
    input.dataset['key'] = `coworker-${key}`
    input.disabled = state.loading
    if (key === 'currency') input.maxLength = 3
    input.addEventListener('input', () => {
      draft[key] = input.value
      if (key === 'name') draft.accountId = null
    })
    wrap.append(element('span', 'report-field-label', label), input)
    grid.append(wrap)
  }
  field('Nombre', 'name', { placeholder: '¿A quién consultas?', mode: 'text', wide: true })
  field('Mes desde', 'from', { placeholder: 'AAAA-MM', mode: 'numeric', type: 'month' })
  field('Mes hasta', 'to', { placeholder: 'AAAA-MM', mode: 'numeric', type: 'month' })
  field('Sueldo mensual', 'salary', { placeholder: 'opcional', mode: 'decimal', wide: true })
  field('Horas al mes', 'hours', { placeholder: '160', mode: 'decimal' })
  field('Multiplicador', 'multiplier', { placeholder: '2', mode: 'decimal' })
  field('Moneda', 'currency', { placeholder: 'MXN', mode: 'text' })
  if (state.sites.length > 1) {
    const wrap = element('label', 'report-field') as HTMLLabelElement
    const select = document.createElement('select')
    select.className = 'report-input'
    select.dataset['key'] = 'coworker-site'
    select.disabled = state.loading
    const fallback = document.createElement('option')
    fallback.value = ''
    fallback.textContent = 'predeterminado'
    select.append(fallback)
    for (const site of state.sites) {
      const option = document.createElement('option')
      option.value = siteValue(site)
      option.textContent = siteValue(site)
      select.append(option)
    }
    select.value = draft.site
    select.addEventListener('change', () => {
      draft.site = select.value
      draft.accountId = null
    })
    wrap.append(element('span', 'report-field-label', 'Sitio'), select)
    grid.append(wrap)
  }
  form.append(grid)

  const actions = element('div', 'coworker-actions')
  if (state.invalid !== null) {
    const status = element('p', 'report-export-status report-export-status--error coworker-status', state.invalid)
    status.setAttribute('role', 'alert')
    actions.append(status)
  } else {
    actions.append(element('p', 'report-meta coworker-status', 'Sin sueldo solo se calculan las horas'))
  }
  const submit = element('button', 'primary-button', state.loading ? 'Consultando…' : 'Consultar') as HTMLButtonElement
  submit.type = 'submit'
  submit.dataset['key'] = 'coworker-submit'
  submit.disabled = state.loading
  actions.append(submit)
  form.append(actions)
  section.append(form)
  return section
}

function excludesCard(app: App, excludes: ExcludesState): HTMLElement {
  const section = card('coworker-excludes', 'Proyectos que no generan horas extra', 'Proyectos que no generan horas extra')
  section.append(element('p', 'report-meta', 'Claves de proyecto de Jira · aplican a todos los compañeros'))
  if (excludes.loading && excludes.keys === null) {
    section.append(element('p', 'report-meta', 'Preguntando a tally…'))
    return section
  }
  if (excludes.error !== null && excludes.keys === null) {
    const problem = describeProblem(excludes.error)
    section.append(notice(problem.message))
    const retry = button('Reintentar', 'ghost-button coworker-retry', () => {
      loadExcludes(app)
      app.render()
    })
    retry.dataset['key'] = 'excludes-retry'
    section.append(retry)
    return section
  }
  const keys = excludes.keys ?? []
  if (keys.length === 0) {
    section.append(element('p', 'report-meta coworker-none', 'Todos los proyectos generan horas extra'))
  } else {
    const list = element('ul', 'coworker-chips')
    list.setAttribute('aria-label', 'Proyectos excluidos')
    for (const key of keys) {
      const chip = element('li', 'coworker-chip')
      const remove = element('button', 'coworker-chip-remove') as HTMLButtonElement
      remove.type = 'button'
      remove.setAttribute('aria-label', `Quitar ${key}`)
      remove.dataset['key'] = `exclude-remove-${key}`
      remove.disabled = excludes.busy
      remove.append(icon('close', 10))
      remove.addEventListener('click', () => changeExclude(app, () => removeOvertimeExclude(key), 'exclude-input', false))
      chip.append(element('span', 'coworker-chip-key', key), remove)
      list.append(chip)
    }
    section.append(list)
  }

  const form = element('form', 'coworker-exclude-form') as HTMLFormElement
  form.setAttribute('aria-label', 'Agregar proyecto excluido')
  form.noValidate = true
  const wrap = element('label', 'report-field coworker-exclude-field') as HTMLLabelElement
  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'report-input'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.maxLength = 20
  input.placeholder = 'PP'
  input.value = excludes.draft
  input.dataset['key'] = 'exclude-input'
  input.disabled = excludes.busy
  input.addEventListener('input', () => {
    excludes.draft = input.value
  })
  wrap.append(element('span', 'report-field-label', 'Clave de proyecto'), input)
  const add = element('button', 'ghost-button', excludes.busy ? 'Guardando…' : 'Agregar') as HTMLButtonElement
  add.type = 'submit'
  add.dataset['key'] = 'exclude-add'
  add.disabled = excludes.busy
  form.append(wrap, add)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const key = excludes.draft.trim().toUpperCase()
    if (!KEY_PATTERN.test(key)) {
      excludes.status = 'La clave va en mayúsculas, como PP'
      app.render()
      focus('exclude-input')
      return
    }
    if ((excludes.keys ?? []).includes(key)) {
      excludes.draft = ''
      excludes.status = `${key} ya está en la lista`
      app.render()
      focus('exclude-input')
      return
    }
    changeExclude(app, () => addOvertimeExclude(key), 'exclude-input', true)
  })
  section.append(form)
  if (excludes.status !== null) {
    const status = element('p', 'report-export-status report-export-status--error', excludes.status)
    status.setAttribute('role', 'alert')
    section.append(status)
  }
  return section
}

function results(app: App, state: CoworkerState): HTMLElement {
  const area = element('div', 'coworker-results')
  area.setAttribute('aria-live', 'polite')
  if (state.loading) {
    area.append(loading('Preguntando a tally y Jira…'))
    return area
  }
  if (state.error !== null) {
    area.append(problemState(state.error, () => consult(app)))
    return area
  }
  if (state.candidates !== null) {
    area.append(candidatesCard(app, state))
    return area
  }
  if (state.result === null) {
    area.append(emptyState('Consulta las horas extra de un compañero', 'Escribe su nombre como aparece en Jira y elige los meses.'))
    return area
  }
  if (state.stale) area.append(notice('La lista de proyectos excluidos cambió · vuelve a consultar para recalcular'))
  area.append(...overtimeResult(app, state, state.result, app.today.slice(0, 7)))
  return area
}

function candidatesCard(app: App, state: CoworkerState): HTMLElement {
  const section = card('coworker-candidates', 'Elige a la persona', 'Hay varias personas con ese nombre')
  section.append(element('p', 'report-meta', 'Elige a quién consultar'))
  const list = element('ul', 'coworker-candidate-list')
  for (const candidate of state.candidates ?? []) {
    const item = element('li')
    const pick = element('button', 'coworker-candidate') as HTMLButtonElement
    pick.type = 'button'
    pick.dataset['key'] = `candidate-${candidate.accountId}`
    pick.append(element('span', 'coworker-candidate-name', candidate.displayName))
    if (candidate.email !== null && candidate.email !== '') pick.append(element('span', 'coworker-candidate-email', candidate.email))
    pick.addEventListener('click', () => {
      state.form.name = candidate.displayName
      state.form.accountId = candidate.accountId
      consult(app)
    })
    item.append(pick)
    list.append(item)
  }
  section.append(list)
  return section
}

function amount(value: number | null, currency: string): string {
  return value === null ? '—' : money(value, currency)
}

function overtimeResult(app: App, state: CoworkerState, overtime: CoworkerOvertime, currentMonth: string): HTMLElement[] {
  const currency = overtime.rate.currency
  const factor = multiplierLabel(overtime.rate.multiplier)
  const paid = overtime.rate.hourlyRate !== null
  const totals = overtime.totals
  const issues = overtime.months.flatMap((month) => month.issues)
  const missing = overtime.months.flatMap((month) => month.withoutEstimate)

  const head = element('div', 'coworker-person')
  head.append(element('h2', 'report-card-title', overtime.person.name))
  const meta = [
    plural(overtime.months.length, 'mes', 'meses'),
    plural(issues.length, 'tarjeta', 'tarjetas'),
    paid ? `hora ${money(overtime.rate.hourlyRate ?? 0, currency)}` : 'sin sueldo · solo horas',
  ]
  head.append(element('span', 'report-meta report-grow', meta.join(' · ')))
  const open = button(state.exporting.open ? 'Ocultar exportar' : 'Exportar', 'ghost-button coworker-export-open', () => {
    state.exporting.open = !state.exporting.open
    state.exporting.status = null
    app.render()
    focus(state.exporting.open ? 'coworker-format-' + state.exporting.format : 'coworker-export-open')
  })
  open.dataset['key'] = 'coworker-export-open'
  open.setAttribute('aria-expanded', String(state.exporting.open))
  head.append(open)
  const panel = state.exporting.open ? exportPanel(app, state, overtime) : null

  const summary = kpis(
    [
      { label: 'Estimadas', value: hours(totals.estimateSeconds), note: `de ${hours(totals.expectedSeconds)} esperadas`, tone: 'estimate' },
      { label: 'Extra', value: hours(totals.overtimeSeconds), note: totals.overtimeSeconds > 0 ? 'sobre lo esperado' : 'sin horas extra' },
      ...(paid
        ? [
            { label: 'Pago ×1', value: amount(totals.payX1, currency), note: 'horas extra a precio normal' },
            { label: `Pago ${factor}`, value: amount(totals.payMultiplied, currency), note: `horas extra ${factor}`, tone: 'ok' as const },
          ]
        : []),
    ],
    170,
  )

  return [head, panel, summary, monthsTable(overtime, totals, currentMonth, paid), issuesCard(issues), missingCard(missing)].filter(
    (node): node is HTMLElement => node !== null,
  )
}

function headRow(columns: [string, string][]): HTMLElement {
  const thead = element('thead')
  const row = element('tr')
  for (const [label, className] of columns) {
    const th = element('th', className, label)
    th.setAttribute('scope', 'col')
    row.append(th)
  }
  thead.append(row)
  return thead
}

function monthsTable(overtime: CoworkerOvertime, totals: CoworkerTotals, currentMonth: string, paid: boolean): HTMLElement {
  const currency = overtime.rate.currency
  const factor = multiplierLabel(overtime.rate.multiplier)
  const section = element('section', 'report-card report-table-card')
  section.setAttribute('aria-label', 'Horas extra por mes')
  const head = element('div', 'report-table-head')
  head.append(element('h2', 'report-card-title report-grow', 'Por mes'), element('span', 'report-meta', `${overtime.rate.monthlyHours} h esperadas al mes`))
  section.append(head)
  if (overtime.months.length === 0) {
    section.append(element('p', 'report-meta coworker-pad', 'Sin meses en el rango'))
    return section
  }
  const scroll = element('div', 'report-table-scroll')
  const table = element('table', paid ? 'report-table report-overtime-table' : 'report-table report-overtime-table coworker-table--hours')
  table.append(element('caption', 'report-sr', paid ? `Horas extra por mes, pago ×1 y ${factor}` : 'Horas extra por mes'))
  const columns: [string, string][] = [
    ['Mes', ''],
    ['Estimadas', 'report-right'],
    ['Esperadas', 'report-right'],
    ['Extra', 'report-right'],
  ]
  if (paid) columns.push(['Pago ×1', 'report-right'], [`Pago ${factor}`, 'report-right'])
  table.append(headRow(columns))
  const body = element('tbody')
  for (const month of overtime.months) {
    const row = element('tr')
    const name = element('th', 'report-overtime-month')
    name.setAttribute('scope', 'row')
    name.append(element('span', undefined, monthLabel(month.month)))
    if (month.month === currentMonth) name.append(element('span', 'tag report-tag--pending', 'en curso'))
    const extra = month.overtimeSeconds > 0
    row.append(
      name,
      element('td', 'report-right report-num', hours(month.estimateSeconds)),
      element('td', 'report-right report-num report-num--dim', hours(month.expectedSeconds)),
      element('td', `report-right report-num ${extra ? 'report-num--strong' : 'report-num--dim'}`, hours(month.overtimeSeconds)),
    )
    if (paid) {
      row.append(
        element('td', 'report-right report-num', amount(month.payX1, currency)),
        element('td', `report-right report-num ${extra ? 'report-num--strong' : ''}`.trim(), amount(month.payMultiplied, currency)),
      )
    }
    body.append(row)
  }
  const foot = element('tfoot')
  const total = element('tr', 'report-overtime-total')
  const label = element('th', undefined, 'Total')
  label.setAttribute('scope', 'row')
  total.append(
    label,
    element('td', 'report-right report-num', hours(totals.estimateSeconds)),
    element('td', 'report-right report-num report-num--dim', hours(totals.expectedSeconds)),
    element('td', 'report-right report-num report-num--strong', hours(totals.overtimeSeconds)),
  )
  if (paid) {
    total.append(
      element('td', 'report-right report-num report-num--strong', amount(totals.payX1, currency)),
      element('td', 'report-right report-num report-num--strong', amount(totals.payMultiplied, currency)),
    )
  }
  foot.append(total)
  table.append(body, foot)
  scroll.append(table)
  section.append(scroll)
  return section
}

function byStart(a: CoworkerIssue, b: CoworkerIssue): number {
  return (a.startDate ?? '').localeCompare(b.startDate ?? '') || a.key.localeCompare(b.key)
}

function issueTable(issues: CoworkerIssue[], label: string, withEstimate: boolean): HTMLElement {
  const scroll = element('div', 'report-table-scroll')
  const table = element('table', 'report-table coworker-table--issues')
  table.append(element('caption', 'report-sr', label))
  const columns: [string, string][] = [
    ['Clave', ''],
    ['Título', ''],
    ['Proyecto', ''],
    ['Fecha de inicio', ''],
  ]
  if (withEstimate) columns.push(['Estimación', 'report-right'])
  table.append(headRow(columns))
  const body = element('tbody')
  for (const issue of [...issues].sort(byStart)) {
    const row = element('tr')
    const summary = element('td', 'coworker-summary', issue.summary)
    summary.title = issue.summary
    const key = element('td', 'report-num coworker-key')
    key.append(issueLink(issue, 'coworker-key-link'))
    row.append(
      key,
      summary,
      element('td', 'report-num report-num--dim', issue.project ?? '—'),
      element('td', 'report-num report-num--dim', issue.startDate === null ? '—' : dayLabel(issue.startDate.slice(0, 10), true)),
    )
    if (withEstimate) row.append(element('td', 'report-right report-num', issue.estimateSeconds === null ? '—' : hours(issue.estimateSeconds)))
    body.append(row)
  }
  table.append(body)
  scroll.append(table)
  return scroll
}

function issuesCard(issues: CoworkerIssue[]): HTMLElement {
  const section = element('section', 'report-card report-table-card')
  section.setAttribute('aria-label', 'Tarjetas')
  const head = element('div', 'report-table-head')
  head.append(element('h2', 'report-card-title report-grow', 'Tarjetas'), element('span', 'report-meta', plural(issues.length, 'tarjeta terminada', 'tarjetas terminadas')))
  section.append(head)
  if (issues.length === 0) section.append(element('p', 'report-meta coworker-pad', 'Sin tarjetas terminadas con estimación en esos meses'))
  else section.append(issueTable(issues, 'Tarjetas con estimación', true))
  return section
}

function missingCard(issues: CoworkerIssue[]): HTMLElement | null {
  if (issues.length === 0) return null
  const section = element('section', 'report-card report-table-card')
  section.setAttribute('aria-label', 'Sin estimación')
  const head = element('div', 'report-table-head')
  head.append(element('h2', 'report-card-title report-grow', 'Sin estimación'), element('span', 'report-meta', 'no suman horas'))
  section.append(head, issueTable(issues, 'Tarjetas sin estimación', false))
  return section
}
