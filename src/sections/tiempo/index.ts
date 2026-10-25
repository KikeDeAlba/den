import { describeProblem, pending, snapshot, timeSummary, toolsStatus, worked } from '../../bita.ts'
import { element } from '../../dom.ts'
import { mountReports, type Reports } from '../../reportes/mount.ts'
import { go } from '../../shell/routes.ts'
import { projectColor } from '../../tabs.ts'
import {
  RANGES,
  excludedLine,
  hoursMinutes,
  isTable,
  overlapLine,
  rangeOf,
  stateLabel,
  tallyTable,
  unregisteredLine,
  workedTable,
  type RangeId,
  type TimeRow,
  type TimeTable,
} from './rows.ts'
import './tiempo.css'
import './reportes.css'

let root: HTMLElement | null = null
let picker: HTMLElement | null = null
let totals: HTMLElement | null = null
let body: HTMLElement | null = null
let reportsHost: HTMLElement | null = null
let reports: Reports | null = null
let range: RangeId | null = null
let ticket = 0

function rangePicker(): HTMLElement {
  const group = element('div', 'tiempo-ranges')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', 'Rango')
  for (const option of RANGES) {
    const button = element('button', 'tiempo-range', option.label) as HTMLButtonElement
    button.type = 'button'
    button.dataset['range'] = option.id
    button.setAttribute('aria-pressed', 'false')
    button.addEventListener('click', () => go(`tiempo/${option.id}`))
    group.append(button)
  }
  return group
}

function figure(text: string, className: string): HTMLElement {
  return element('span', `tiempo-figure ${className}`, text)
}

function paintTotals(table: TimeTable | null): void {
  if (totals === null) return
  if (table === null) {
    totals.replaceChildren()
    return
  }
  const worked = figure(hoursMinutes(table.workedSeconds), 'tiempo-figure--worked')
  worked.title = 'trabajado'
  if (table.estimateSeconds === null) {
    totals.replaceChildren(worked)
    return
  }
  const estimate = figure(hoursMinutes(table.estimateSeconds), 'tiempo-figure--estimate')
  estimate.title = 'estimado'
  totals.replaceChildren(worked, element('span', 'tiempo-arrow', '→'), estimate)
}

function note(text: string, tone: 'estimate' | 'quiet' = 'estimate'): HTMLElement {
  const line = element('p', `tiempo-note tiempo-note--${tone}`)
  line.append(element('span', 'tiempo-note-dot'), element('span', undefined, text))
  return line
}

function head(): HTMLElement {
  const row = element('div', 'tiempo-row tiempo-row--head')
  row.setAttribute('role', 'row')
  const labels = ['Tarea', 'Proyecto', 'Trabajado', 'Estimado', 'Jira']
  for (const [index, label] of labels.entries()) {
    const cell = element('span', index === 2 || index === 3 ? 'tiempo-cell tiempo-cell--num' : 'tiempo-cell', label)
    cell.setAttribute('role', 'columnheader')
    row.append(cell)
  }
  return row
}

function cell(className: string): HTMLElement {
  const node = element('span', `tiempo-cell ${className}`)
  node.setAttribute('role', 'cell')
  return node
}

function line(row: TimeRow): HTMLElement {
  const node = element('div', 'tiempo-row')
  node.setAttribute('role', 'row')

  const task = cell('tiempo-task')
  task.append(element('span', 'tiempo-title', row.title), element('span', 'tiempo-meta', row.meta))
  task.title = row.title

  const project = cell('tiempo-project')
  const dot = element('i', 'tiempo-dot')
  dot.style.background = projectColor(row.projectId)
  project.append(dot, element('span', 'tiempo-project-name', row.project))

  const worked = cell('tiempo-cell--num')
  worked.textContent = hoursMinutes(row.workedSeconds)

  const estimate = cell('tiempo-cell--num tiempo-estimate')
  estimate.textContent = row.estimateSeconds === null ? '—' : hoursMinutes(row.estimateSeconds)

  const jira = cell('tiempo-jira')
  jira.append(element('span', 'tiempo-key', row.issueKey ?? '—'))
  const state = stateLabel(row)
  if (state !== '') {
    const label = element('span', 'tiempo-state', state)
    label.dataset['state'] = row.state
    jira.append(label)
  }

  node.append(task, project, worked, estimate, jira)
  return node
}

function paintTable(target: HTMLElement, table: TimeTable, problem: string | null): void {
  const nodes: HTMLElement[] = []
  for (const overlap of table.overlaps) nodes.push(note(overlapLine(overlap)))
  if (problem !== null) nodes.push(note(problem, 'quiet'))

  if (table.rows.length === 0) {
    nodes.push(element('p', 'tiempo-empty', 'Nada medido en este rango.'))
  } else {
    const grid = element('div', 'tiempo-table')
    grid.setAttribute('role', 'table')
    grid.setAttribute('aria-label', 'Tareas del rango')
    grid.append(head(), ...table.rows.map(line))
    nodes.push(grid)
  }

  const unregistered = unregisteredLine(table)
  if (unregistered !== null && table.rows.length > 0) nodes.push(note(unregistered, table.unregistered > 0 ? 'estimate' : 'quiet'))
  const excluded = excludedLine(table.excluded)
  if (excluded !== null) nodes.push(note(excluded, 'quiet'))
  if (table.jira && table.rows.length > 0) {
    nodes.push(element('p', 'tiempo-legend', 'El redondeo sube a la media hora por tarea; el total es la suma de estimaciones ya redondeadas.'))
  }
  target.replaceChildren(...nodes)
}

async function loadTable(which: 'today' | 'week'): Promise<{ table: TimeTable; problem: string | null }> {
  const jira = await toolsStatus()
    .then((status) => status.modules.jira)
    .catch(() => false)
  if (jira) {
    try {
      const [summary, waiting, current] = await Promise.all([
        timeSummary(which),
        pending().catch(() => null),
        snapshot().catch(() => null),
      ])
      const pendingIds = waiting === null ? null : new Set(waiting.groups.flatMap((group) => group.entryIds))
      const runningIds = new Set((current?.running ?? []).map((timer) => timer.id))
      return { table: tallyTable(summary, pendingIds, runningIds), problem: null }
    } catch (error) {
      const table = workedTable(await worked(which))
      return { table, problem: `Sin datos de Jira: ${describeProblem(error).message}` }
    }
  }
  return { table: workedTable(await worked(which)), problem: null }
}

async function showTable(target: HTMLElement, which: 'today' | 'week', mine: number): Promise<void> {
  if (target.childElementCount === 0) target.append(element('p', 'tiempo-empty', 'Cargando…'))
  try {
    const { table, problem } = await loadTable(which)
    if (mine !== ticket) return
    paintTotals(table)
    paintTable(target, table, problem)
  } catch (error) {
    if (mine !== ticket) return
    paintTotals(null)
    const box = element('div', 'problem')
    const found = describeProblem(error)
    box.append(element('p', 'problem-message', found.message))
    if (found.hint !== null) box.append(element('code', 'problem-hint', found.hint))
    target.replaceChildren(box)
  }
}

function select(next: RangeId): void {
  if (root === null || picker === null || body === null || reportsHost === null) return
  const changed = next !== range
  range = next
  root.dataset['range'] = next
  for (const button of picker.querySelectorAll<HTMLButtonElement>('button[data-range]')) {
    button.setAttribute('aria-pressed', String(button.dataset['range'] === next))
  }
  ticket += 1
  if (isTable(next)) {
    body.hidden = false
    reportsHost.hidden = true
    if (changed) body.replaceChildren()
    void showTable(body, next === 'hoy' ? 'today' : 'week', ticket)
    return
  }
  body.hidden = true
  reportsHost.hidden = false
  paintTotals(null)
  const preset = next === 'mes' ? 'month' : 'custom'
  if (reports === null) reports = mountReports(reportsHost, preset)
  else reports.choose(preset)
}

export function mount(host: HTMLElement, path: readonly string[]): void {
  root = element('div', 'tiempo')
  const header = element('header', 'tiempo-head')
  picker = rangePicker()
  totals = element('div', 'tiempo-totals')
  header.append(element('h1', 'tiempo-heading', 'Tiempo'), picker, element('span', 'tiempo-spacer'), totals)
  body = element('div', 'tiempo-body')
  reportsHost = element('div')
  reportsHost.id = 'reportes'
  reportsHost.hidden = true
  root.append(header, body, reportsHost)
  host.replaceChildren(root)
  select(rangeOf(path))
}

export function update(path: readonly string[]): void {
  select(rangeOf(path))
}

export function unmount(): void {
  reports?.dispose()
  reports = null
  root = null
  picker = null
  totals = null
  body = null
  reportsHost = null
  range = null
}
