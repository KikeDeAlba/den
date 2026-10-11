import { describeProblem } from './bita.ts'
import { element, must } from './dom.ts'
import type { App, ExportState, View } from './reportes/app.ts'
import { clearSalaryField, coworkersView, coworkerState, forgetSalary, prepareCoworkers } from './reportes/coworkers.ts'
import { dashboard } from './reportes/dashboard.ts'
import { detail } from './reportes/detail.ts'
import { exportView } from './reportes/export.ts'
import { draftFrom, loadPay, payPanel } from './reportes/pay.ts'
import { localToday, presetChoice, projectKey, rangeQuery, type PresetId, type RangeChoice } from './reportes/model.ts'
import { DEFAULT_PAY, fetchReport, type ReportView } from './reportes/types.ts'

const root = must<HTMLDivElement>('#reportes')
const today = localToday()
let lastView = ''

const app: App = {
  view: { name: 'dashboard' },
  choice: presetChoice('30d', today),
  shownPreset: '30d',
  main: { report: null, error: null, loading: true, token: 0 },
  excluded: new Set(),
  grouping: 'day',
  railExpanded: false,
  tableExpanded: false,
  copied: false,
  detail: null,
  exporting: null,
  pay: { settings: null, error: null, open: false, draft: null, saving: false, status: null },
  coworkers: coworkerState(today),
  today,
  render,
  navigate,
  selectPreset,
  applyRange,
  reload: loadMain,
  openExport,
  openPay,
  closePay,
  openCoworkers,
}

function render(): void {
  if (document.body.classList.contains('printing')) return
  const viewKey = app.view.name === 'detail' ? `detail:${projectKey(app.view.projectId)}` : app.view.name
  const sameView = viewKey === lastView
  const scroll = sameView ? root.scrollTop : 0
  const focused = document.activeElement instanceof HTMLElement ? document.activeElement.dataset['key'] : undefined

  const strip = element('div', 'report-drag')
  strip.setAttribute('data-tauri-drag-region', '')
  strip.setAttribute('aria-hidden', 'true')
  const page =
    app.view.name === 'dashboard'
      ? dashboard(app)
      : app.view.name === 'detail'
        ? detail(app, app.view.projectId)
        : app.view.name === 'coworkers'
          ? coworkersView(app)
          : exportView(app, loadExport)
  root.replaceChildren(strip, page)
  if (app.pay.open && app.view.name === 'dashboard') root.append(payPanel(app, app.main.report?.projects ?? []))
  root.dataset['view'] = app.view.name

  root.scrollTop = scroll
  lastView = viewKey
  if (focused !== undefined) {
    const target = root.querySelector<HTMLElement>(`[data-key="${CSS.escape(focused)}"]`)
    target?.focus({ preventScroll: true })
  }
}

function navigate(view: View): void {
  if (app.exporting?.busy === true) return
  if (app.view.name === 'coworkers' && view.name !== 'coworkers') forgetSalary(app.coworkers)
  app.view = view
  if (view.name === 'detail') loadDetail(view.projectId)
  if (view.name === 'coworkers') prepareCoworkers(app)
  render()
}

function openCoworkers(): void {
  if (app.pay.open) closePay()
  navigate({ name: 'coworkers' })
  root.querySelector<HTMLElement>('[data-key="coworker-name"]')?.focus()
}

function hideCoworkers(): void {
  forgetSalary(app.coworkers)
  if (app.view.name === 'coworkers') render()
}

function openPay(): void {
  if (app.pay.open) return
  app.pay.open = true
  app.pay.status = app.pay.error === null ? null : `No se pudo leer tu pago guardado: ${describeProblem(app.pay.error).message}`
  app.pay.draft = draftFrom(app.pay.settings ?? DEFAULT_PAY)
  render()
  root.querySelector<HTMLElement>('[data-key="pay-salary"]')?.focus()
}

function closePay(): void {
  if (!app.pay.open || app.pay.saving) return
  app.pay.open = false
  app.pay.draft = null
  app.pay.status = null
  render()
  root.querySelector<HTMLElement>('[data-key="pay-open"]')?.focus()
}

function selectPreset(preset: PresetId): void {
  if (preset === 'custom') {
    app.choice = presetChoice('custom', today, resolved(app.choice))
    render()
    return
  }
  applyRange(presetChoice(preset, today, app.choice))
}

function applyRange(choice: RangeChoice): void {
  app.choice = choice
  loadMain()
}

function resolved(choice: RangeChoice): RangeChoice {
  const report = app.main.report
  if (report === null) return choice
  return { ...choice, from: report.range.fromDay, to: report.range.toDay }
}

function loadMain(): void {
  const token = ++app.main.token
  app.main.loading = true
  app.main.error = null
  render()
  fetchReport(rangeQuery(app.choice), null, false)
    .then((report) => {
      if (token !== app.main.token) return
      app.main.report = report
      app.shownPreset = app.choice.preset
      app.choice = { ...app.choice, from: report.range.fromDay, to: report.range.toDay }
      const keys = new Set(report.projects.map((project) => projectKey(project.projectId)))
      for (const key of [...app.excluded]) if (!keys.has(key)) app.excluded.delete(key)
    })
    .catch((error: unknown) => {
      if (token !== app.main.token) return
      app.main.error = error
      app.main.report = null
    })
    .finally(() => {
      if (token !== app.main.token) return
      app.main.loading = false
      render()
    })
}

function loadDetail(projectId: number | null): void {
  const key = projectKey(projectId)
  const previous = app.detail
  const token = (previous?.token ?? 0) + 1
  app.detail = { key, report: null, error: null, loading: true, token, sort: previous?.key === key ? previous.sort : 'date' }
  const report = app.main.report
  const range = report === null ? rangeQuery(app.choice) : { from: report.range.fromDay, to: report.range.toDay }
  fetchReport(range, projectId, true)
    .then((data) => settle(token, data, null))
    .catch((error: unknown) => settle(token, null, error))
}

function settle(token: number, data: ReportView | null, error: unknown): void {
  const state = app.detail
  if (state === null || state.token !== token) return
  state.report = data
  state.error = error
  state.loading = false
  if (app.view.name === 'detail') render()
}

function openExport(scope: { projectId: number | null } | null): void {
  const only = scope === null ? null : new Set([projectKey(scope.projectId)])
  const state: ExportState = {
    report: null,
    error: null,
    loading: true,
    token: (app.exporting?.token ?? 0) + 1,
    choice: resolved(app.choice),
    format: app.exporting?.format ?? 'pdf',
    groupBy: app.exporting?.groupBy ?? 'project',
    include: app.exporting?.include ?? { charts: true, projects: true, entries: true, jira: false, pay: false },
    destination: app.exporting?.destination === 'clipboard' ? 'clipboard' : 'downloads',
    only,
    excluded: new Set(scope === null ? app.excluded : []),
    expanded: false,
    status: null,
    busy: false,
  }
  app.exporting = state
  app.view = { name: 'export' }
  loadExport()
}

function loadExport(): void {
  const state = app.exporting
  if (state === null || state.busy) return
  const token = ++state.token
  state.loading = true
  state.error = null
  state.status = null
  render()
  fetchReport(rangeQuery(state.choice), null, true)
    .then((report) => {
      if (state.token !== token) return
      state.report = report
      state.choice = { ...state.choice, from: report.range.fromDay, to: report.range.toDay }
    })
    .catch((error: unknown) => {
      if (state.token !== token) return
      state.report = null
      state.error = error
    })
    .finally(() => {
      if (state.token !== token) return
      state.loading = false
      if (app.view.name === 'export') render()
    })
}

document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return
  if (app.pay.open) {
    closePay()
    return
  }
  if (app.view.name === 'dashboard') return
  if (app.exporting?.busy === true) return
  navigate({ name: 'dashboard' })
})

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'hidden') return
  clearSalaryField(app.coworkers)
  if (app.view.name === 'coworkers') render()
})
window.addEventListener('pagehide', hideCoworkers)
void import('@tauri-apps/api/window')
  .then(({ getCurrentWindow }) => getCurrentWindow().listen('tauri://close-requested', hideCoworkers))
  .catch(() => undefined)

loadMain()
void loadPay(app).then(() => {
  if (app.view.name === 'dashboard') render()
})
