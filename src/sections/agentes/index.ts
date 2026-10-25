import {
  describeProblem,
  projects as loadProjects,
  type AgentInfo,
  type HarnessId,
  type Problem,
  type Project,
  type SessionDirectory,
  type SessionListing,
  type SpawnRequest,
} from '../../bita.ts'
import { element, icon } from '../../dom.ts'
import { projectColor } from '../../shell/colors.ts'
import { shellState } from '../../shell/hub.ts'
import { go } from '../../shell/routes.ts'
import type { ShellEvent } from '../section.ts'
import * as api from './api.ts'
import { canDismiss, isDismissed, pruneDismissed, readDismissed, rememberDismissed } from './dismissed.ts'
import * as model from './model.ts'
import { createTerminal, type TerminalView } from './terminal.ts'
import './agentes.css'

type ViewKind = 'session' | 'mosaic' | 'new'

interface Row {
  info: AgentInfo
  view: TerminalView
  sent: string
}

interface Form {
  harness: HarnessId
  folder: string | null
  dirs: SessionDirectory[]
  projects: Project[]
  resumeHere: boolean
  resumeList: SessionListing[]
  resumeTicket: number
  problem: Problem | null
  busy: boolean
}

const rows = new Map<number, Row>()
let host: HTMLElement | null = null
let view: ViewKind = 'session'
let selected: number | null = null
let pendingEntry: number | null = null
let pane: model.Pane = model.DEFAULT_PANE
let loaded = false
let sessionProblem: Problem | null = null
let form: Form = freshForm()

const root = element('div', 'agentes')
const tabs = element('div', 'agentes-tabs')
tabs.setAttribute('role', 'tablist')
tabs.setAttribute('aria-label', 'Sesiones')
const body = element('div', 'agentes-body')
root.append(tabs, body)

const composer = document.createElement('input')
composer.type = 'text'
composer.id = 'agentes-composer'
composer.autocomplete = 'off'
composer.spellcheck = false
composer.placeholder = 'Escribe al agente principal'

const promptBox = document.createElement('textarea')
promptBox.id = 'agentes-prompt'
promptBox.rows = 4
promptBox.placeholder = '¿Qué le pides al agente?'

const projectSelect = document.createElement('select')
projectSelect.id = 'agentes-project'

function freshForm(): Form {
  return {
    harness: 'claude',
    folder: null,
    dirs: [],
    projects: [],
    resumeHere: false,
    resumeList: [],
    resumeTicket: 0,
    problem: null,
    busy: false,
  }
}

function ignore(): void {}

function ordered(): Row[] {
  return [...rows.values()].sort((left, right) => left.info.id - right.info.id)
}

function projectName(id: string | null): string {
  if (id === null || id === model.NO_PROJECT) return 'sin proyecto'
  return form.projects.find((project) => String(project.id) === id)?.name ?? `proyecto ${id}`
}

function button(label: string, className?: string): HTMLButtonElement {
  const node = element('button', className, label) as HTMLButtonElement
  node.type = 'button'
  return node
}

function dot(color: string | null): HTMLElement {
  const node = element('span', color === null ? 'agentes-dot agentes-dot--none' : 'agentes-dot')
  if (color !== null) node.style.background = color
  return node
}

function label(text: string): HTMLElement {
  return element('span', 'agentes-label', text)
}

function problemLine(problem: Problem | null): HTMLElement | null {
  if (problem === null) return null
  const box = element('div', 'agentes-problem')
  box.append(element('p', 'agentes-problem-message', problem.message))
  if (problem.hint !== null) box.append(element('code', 'agentes-problem-hint', problem.hint))
  return box
}

function makeView(id: () => number | null): TerminalView {
  return createTerminal({
    input(data) {
      const target = id()
      if (target !== null && rows.get(target)?.info.alive === true) void api.writeAgent(target, data).catch(ignore)
    },
    resize(cols, lines) {
      const target = id()
      const row = target === null ? undefined : rows.get(target)
      if (target === null || row === undefined || !row.info.alive) return
      row.sent = `${cols}x${lines}`
      void api.resizeAgent(target, cols, lines).catch(ignore)
    },
  })
}

function syncSize(row: Row): void {
  if (!row.info.alive) return
  const { cols, rows: lines } = row.view.size()
  const size = `${cols}x${lines}`
  if (row.sent === size) return
  row.sent = size
  void api.resizeAgent(row.info.id, cols, lines).catch(ignore)
}

function navigate(next: model.AgentesView): void {
  go(model.agentesRoute(next))
}

function openSession(id: number): void {
  navigate({ kind: 'session', id })
}

function clockFor(info: AgentInfo, className: string): HTMLElement {
  const clock = element('span', className, info.alive ? model.shortClock(model.elapsed(info.startedAt, new Date())) : 'terminó')
  if (info.alive) clock.dataset['clock'] = info.startedAt
  return clock
}

function fillTab(tab: HTMLElement, row: Row): void {
  const active = view === 'session' && selected === row.info.id
  tab.className = active ? 'agentes-tab agentes-tab--on' : 'agentes-tab'
  tab.setAttribute('aria-selected', String(active))
  tab.replaceChildren(
    dot(row.info.alive ? 'var(--running)' : 'var(--fg-faint)'),
    element('span', 'agentes-tab-title', model.sessionTitle(row.info)),
    clockFor(row.info, 'agentes-tab-clock'),
  )
}

function tabFor(row: Row): HTMLButtonElement {
  const tab = document.createElement('button')
  tab.type = 'button'
  tab.setAttribute('role', 'tab')
  tab.dataset['session'] = String(row.info.id)
  fillTab(tab, row)
  tab.addEventListener('click', () => openSession(row.info.id))
  return tab
}

function toggle(text: string, on: boolean, run: () => void): HTMLButtonElement {
  const node = button(text, on ? 'agentes-toggle agentes-toggle--on' : 'agentes-toggle')
  node.setAttribute('aria-pressed', String(on))
  node.addEventListener('click', run)
  return node
}

function renderTabs(): void {
  const list = ordered().map(tabFor)
  const fresh = element('button', view === 'new' ? 'agentes-tab agentes-tab--on agentes-new' : 'agentes-tab agentes-new') as HTMLButtonElement
  fresh.type = 'button'
  fresh.append(icon('plus', 12), document.createTextNode('Nueva sesión'))
  fresh.addEventListener('click', () => navigate({ kind: 'new' }))
  const tools = element('div', 'agentes-views')
  if (view === 'session' && selected !== null) {
    tools.append(
      toggle('Actividad', pane === 'activity', () => setPane('activity')),
      toggle('Terminal', pane === 'terminal', () => setPane('terminal')),
      element('span', 'agentes-divider'),
    )
  }
  tools.append(
    toggle('Una sesión', view === 'session', () => navigate({ kind: 'session', id: selected })),
    toggle('Mosaico', view === 'mosaic', () => navigate({ kind: 'mosaic' })),
  )
  tabs.replaceChildren(...list, fresh, element('span', 'agentes-spacer'), tools)
}

function setPane(next: model.Pane): void {
  pane = next
  render()
}

function gate(state: model.Readiness): HTMLElement | null {
  if (state.kind !== 'missing' && state.kind !== 'outdated') return null
  const box = element('div', 'agentes-gate')
  if (state.kind === 'missing') {
    box.append(element('p', 'agentes-gate-title', 'Para lanzar agentes hace falta bita'))
    box.append(element('p', 'agentes-gate-note', 'Den lanza cada sesión con bita work. Se instala así:'))
  } else {
    box.append(element('p', 'agentes-gate-title', 'Tu bita todavía no sabe lanzar sesiones desde Den'))
    box.append(element('p', 'agentes-gate-note', `Le falta: ${state.lacking.join(', ')}. Actualízala y Den la detecta sola:`))
  }
  box.append(element('code', 'agentes-gate-hint', state.install))
  const open = button('Ver las herramientas', 'ghost-button')
  open.addEventListener('click', () => go('ajustes'))
  box.append(open)
  return box
}

function laneNav(row: Row): HTMLElement {
  const nav = element('nav', 'agentes-lanes')
  nav.setAttribute('aria-label', 'Agentes de la sesión')
  nav.append(element('span', 'agentes-lanes-meta', model.sessionMeta(row.info, projectName)))
  const lane = element('div', 'agentes-lane agentes-lane--on')
  const head = element('span', 'agentes-lane-head')
  head.append(dot(row.info.alive ? 'var(--running)' : 'var(--ok)'), element('span', 'agentes-lane-name', 'principal'))
  head.append(element('span', 'agentes-lane-sub', model.harnessLabel(row.info.bita?.harness ?? row.info.harness)))
  const status = row.info.alive ? 'trabajando' : row.info.exitCode === null || row.info.exitCode === 0 ? 'terminó' : `terminó con código ${row.info.exitCode}`
  lane.append(head, element('span', row.info.alive ? 'agentes-lane-status' : 'agentes-lane-status agentes-lane-status--done', status))
  nav.append(lane)
  if (row.info.bita !== null) nav.append(element('span', 'agentes-lane-entry', `entrada #${row.info.bita.entryId}`))
  return nav
}

function activityPlaceholder(): HTMLElement {
  const box = element('div', 'agentes-activity')
  box.append(element('p', 'agentes-activity-title', 'La actividad de los agentes llega pronto'))
  box.append(element('p', 'agentes-activity-note', 'Mientras tanto, sigue la sesión en la Terminal.'))
  const open = button('Ver la terminal', 'ghost-button')
  open.addEventListener('click', () => setPane('terminal'))
  box.append(open)
  return box
}

async function resume(listing: SessionListing, title: string | null): Promise<void> {
  await launch({ resumeSession: listing.id, cwd: listing.cwd, ...(title === null ? {} : { title }) })
}

function composerRow(row: Row): HTMLElement {
  const bar = element('div', 'agentes-composer')
  const hidden = element('label', 'visually-hidden', 'Mensaje para el agente principal') as HTMLLabelElement
  hidden.htmlFor = composer.id
  composer.disabled = !row.info.alive
  const actions = element('span', 'agentes-composer-actions')
  actions.append(...composerActions(row))
  bar.append(hidden, composer, element('span', 'tag', '⏎'), actions)
  return bar
}

function composerActions(row: Row): HTMLElement[] {
  const bar: HTMLElement[] = []
  if (row.info.alive) {
    const end = button('Terminar la sesión', 'quiet-link quiet-link--danger')
    end.addEventListener('click', () => {
      void api.killAgent(row.info.id).catch((error: unknown) => {
        sessionProblem = describeProblem(error)
        render()
      })
    })
    bar.push(end)
  } else {
    const linked = row.info.bita
    if (linked !== null) {
      const again = button('Retomar', 'ghost-button')
      again.addEventListener('click', () => void resume(linked, model.sessionTitle(row.info)))
      bar.push(again)
    }
    const close = button('Cerrar la pestaña', 'quiet-link')
    close.addEventListener('click', () => dismiss(row.info.id))
    bar.push(close)
  }
  return bar
}

function sessionPane(row: Row): HTMLElement {
  const wrap = element('div', 'agentes-session')
  wrap.dataset['session'] = String(row.info.id)
  const main = element('section', 'agentes-main')
  main.setAttribute('aria-label', model.sessionTitle(row.info))
  if (pane === 'activity') {
    main.append(activityPlaceholder())
  } else {
    const frame = element('div', 'agentes-term')
    frame.append(row.view.element)
    main.append(frame)
  }
  const problem = problemLine(sessionProblem)
  if (problem !== null) main.append(problem)
  main.append(composerRow(row))
  wrap.append(laneNav(row), main)
  return wrap
}

function mosaicPane(): HTMLElement {
  const grid = element('div', 'agentes-mosaic')
  for (const row of ordered()) {
    const tile = element('section', 'agentes-tile')
    tile.dataset['session'] = String(row.info.id)
    const head = element('div', 'agentes-tile-head')
    const title = button(model.sessionTitle(row.info), 'agentes-tile-title')
    title.addEventListener('click', () => openSession(row.info.id))
    head.append(title, clockFor(row.info, 'agentes-tile-clock'))
    const frame = element('div', 'agentes-term agentes-term--tile')
    frame.append(row.view.element)
    const open = button('Abrir la sesión', 'quiet-link')
    open.addEventListener('click', () => openSession(row.info.id))
    tile.append(head, element('span', 'agentes-tile-meta', model.sessionMeta(row.info, projectName)), frame, open)
    grid.append(tile)
  }
  return grid
}

function emptySessions(): HTMLElement {
  const box = element('div', 'agentes-gate')
  box.append(element('p', 'agentes-gate-title', 'Todavía no hay sesiones lanzadas desde Den'))
  box.append(element('p', 'agentes-gate-note', 'Arranca una con Claude, OpenCode, Codex o Gemini.'))
  const start = button('Nueva sesión', 'primary-button')
  start.addEventListener('click', () => navigate({ kind: 'new' }))
  box.append(start)
  return box
}

function request(): SpawnRequest {
  const folderRow = form.dirs.find((dir) => dir.cwd === form.folder) ?? null
  const prompt = promptBox.value.trim()
  return {
    harness: form.harness,
    project: model.projectArg(projectSelect.value === '' ? null : projectSelect.value, folderRow),
    ...(form.folder === null ? {} : { cwd: form.folder }),
    ...(prompt === '' ? {} : { prompt }),
  }
}

function fillProjects(): void {
  const current = projectSelect.value
  const options = [new Option('Sin cronómetro', model.NO_PROJECT)]
  for (const project of form.projects.filter((item) => item.active)) options.push(new Option(project.name, String(project.id)))
  projectSelect.replaceChildren(...options)
  projectSelect.value = options.some((option) => option.value === current) ? current : model.NO_PROJECT
}

function chooseFolder(path: string, projectId: number | null | undefined): void {
  form.folder = path
  if (projectId !== undefined) projectSelect.value = projectId === null ? model.NO_PROJECT : String(projectId)
  if (form.resumeHere) void loadResume()
  render()
}

async function browse(): Promise<void> {
  try {
    const picked = await api.pickFolder(form.folder)
    if (picked === null) return
    const known = form.dirs.find((dir) => dir.cwd === picked)
    chooseFolder(picked, known === undefined ? undefined : known.projectId)
  } catch (error) {
    form.problem = describeProblem(error)
    render()
  }
}

function field(name: string, content: HTMLElement, grow = false): HTMLElement {
  const box = element('div', grow ? 'agentes-field agentes-field--grow' : 'agentes-field')
  box.append(label(name), content)
  return box
}

function harnessPicker(): HTMLElement {
  const group = element('div', 'agentes-harness')
  group.setAttribute('role', 'radiogroup')
  group.setAttribute('aria-label', 'Agente')
  for (const harness of model.HARNESSES) {
    const on = form.harness === harness.id
    const choice = button(harness.label, on ? 'agentes-harness-option agentes-harness-option--on' : 'agentes-harness-option')
    choice.setAttribute('role', 'radio')
    choice.setAttribute('aria-checked', String(on))
    choice.addEventListener('click', () => {
      form.harness = harness.id
      render()
    })
    group.append(choice)
  }
  return group
}

function newForm(): HTMLElement {
  const formNode = document.createElement('form')
  formNode.className = 'agentes-form'
  formNode.addEventListener('submit', (event) => {
    event.preventDefault()
    void start()
  })
  formNode.append(element('h1', 'agentes-title', 'Nueva sesión'), field('Agente', harnessPicker()))

  const row = element('div', 'agentes-form-row')
  const projectBox = element('div', 'agentes-select')
  const chosen = projectSelect.value
  projectBox.append(dot(chosen === model.NO_PROJECT || chosen === '' ? null : projectColor(Number(chosen))), projectSelect)
  const folderButton = element('button', 'agentes-folder') as HTMLButtonElement
  folderButton.type = 'button'
  folderButton.append(icon('folder', 12), element('span', 'agentes-folder-path', form.folder ?? 'Elige una carpeta'))
  folderButton.addEventListener('click', () => void browse())
  row.append(field('Proyecto', projectBox), field('Carpeta', folderButton, true))
  formNode.append(row)

  const promptLabel = element('label', 'agentes-field') as HTMLLabelElement
  promptLabel.htmlFor = promptBox.id
  promptLabel.append(label('Primer mensaje (opcional)'), promptBox)
  formNode.append(promptLabel)

  const actions = element('div', 'agentes-form-actions')
  actions.append(element('code', 'agentes-preview', model.commandPreview(request())))
  if (rows.size > 0) {
    const cancel = button('Cancelar', 'quiet-link')
    cancel.addEventListener('click', () => navigate({ kind: 'session', id: selected }))
    actions.append(cancel)
  }
  const submit = element('button', 'primary-button', form.busy ? 'Arrancando…' : 'Arrancar sesión') as HTMLButtonElement
  submit.type = 'submit'
  submit.disabled = form.busy || form.folder === null
  actions.append(submit)
  formNode.append(actions)
  const problem = problemLine(form.problem)
  if (problem !== null) formNode.append(problem)
  return formNode
}

function recentFolders(): HTMLElement {
  const section = element('section', 'agentes-recent')
  section.setAttribute('aria-label', 'Carpetas recientes')
  section.append(label('Carpetas recientes'))
  const now = new Date()
  for (const dir of form.dirs) {
    const on = dir.cwd === form.folder
    const item = element('button', on ? 'agentes-recent-row agentes-recent-row--on' : 'agentes-recent-row') as HTMLButtonElement
    item.type = 'button'
    item.setAttribute('aria-pressed', String(on))
    item.title = dir.cwd
    const text = element('span', 'agentes-recent-text')
    text.append(element('span', 'agentes-recent-path', model.shortPath(dir.cwd)), element('span', 'agentes-recent-meta', model.folderMeta(dir)))
    item.append(dot(dir.projectId === null ? null : projectColor(dir.projectId)), text, element('span', 'agentes-recent-when', model.dayLabel(dir.lastUsedAt, now)))
    item.addEventListener('click', () => chooseFolder(dir.cwd, dir.projectId))
    section.append(item)
  }
  if (form.dirs.length === 0) section.append(element('p', 'agentes-empty', 'Todavía no hay carpetas con sesiones.'))
  const other = button('Elegir otra carpeta…', 'quiet-link agentes-other')
  other.addEventListener('click', () => void browse())
  section.append(other)
  return section
}

function resumeSection(): HTMLElement {
  const section = element('section', 'agentes-resume')
  section.setAttribute('aria-label', 'Retomar una sesión')
  const head = element('div', 'agentes-resume-head')
  head.append(
    label('Retomar una sesión'),
    toggle('Todas', !form.resumeHere, () => setResumeFilter(false)),
    toggle('Esta carpeta', form.resumeHere, () => setResumeFilter(true)),
  )
  section.append(head)
  const now = new Date()
  const list = model.resumable(form.resumeList)
  for (const listing of list) {
    const item = element('div', 'agentes-resume-row')
    const text = element('span', 'agentes-resume-text')
    const title = element('span', 'agentes-resume-title', model.resumeTitle(listing))
    title.append(element('span', 'agentes-resume-id', ` #${listing.id}`))
    text.append(title, element('span', 'agentes-resume-meta', model.resumeMeta(listing, now)))
    const again = button('Retomar', 'agentes-resume-button')
    again.title = model.commandPreview({ resumeSession: listing.id })
    again.addEventListener('click', () => void resume(listing, model.resumeTitle(listing)))
    item.append(text, again)
    section.append(item)
  }
  if (list.length === 0) {
    section.append(element('p', 'agentes-empty agentes-empty--line', form.resumeHere ? 'No hay sesiones terminadas en esta carpeta.' : 'No hay sesiones terminadas todavía.'))
  }
  section.append(element('span', 'agentes-hint', 'bita work --resume --session <id>'))
  return section
}

function setResumeFilter(here: boolean): void {
  form.resumeHere = here
  render()
  void loadResume()
}

function newPane(): HTMLElement {
  const wrap = element('div', 'agentes-new-pane')
  const inner = element('div', 'agentes-new-inner')
  const aside = element('aside', 'agentes-aside')
  aside.append(recentFolders(), resumeSection())
  inner.append(newForm(), aside)
  wrap.append(inner)
  return wrap
}

function placeTerminals(): void {
  for (const row of rows.values()) {
    const visible = (view === 'session' && pane === 'terminal' && selected === row.info.id) || view === 'mosaic'
    if (visible && row.view.element.isConnected) {
      row.view.show()
      syncSize(row)
    } else {
      row.view.hide()
    }
  }
}

function render(): void {
  if (host === null) return
  if (view === 'session' && (selected === null || !rows.has(selected))) selected = ordered().at(-1)?.info.id ?? null
  renderTabs()
  const blocked = rows.size === 0 ? gate(model.readiness(shellState().tools)) : null
  let content: HTMLElement
  if (blocked !== null) content = blocked
  else if (view === 'new') content = newPane()
  else if (view === 'mosaic') content = rows.size === 0 ? emptySessions() : mosaicPane()
  else {
    const row = selected === null ? undefined : rows.get(selected)
    content = row === undefined ? (loaded ? newPane() : element('div')) : sessionPane(row)
  }
  body.replaceChildren(content)
  placeTerminals()
}

function attachRow(info: AgentInfo, terminal: TerminalView): Row {
  const row: Row = { info, view: terminal, sent: '' }
  rows.set(info.id, row)
  return row
}

async function launch(spawn: SpawnRequest): Promise<void> {
  if (form.busy) return
  form.busy = true
  form.problem = null
  sessionProblem = null
  render()
  let id: number | null = null
  const terminal = makeView(() => id)
  try {
    const size = ordered().at(-1)?.view.size()
    const info = await api.spawnAgent(spawn, size?.cols ?? 0, size?.rows ?? 0, (bytes) => terminal.write(bytes))
    id = info.id
    attachRow(info, terminal)
    promptBox.value = ''
    form.busy = false
    selected = info.id
    pane = model.DEFAULT_PANE
    openSession(info.id)
    render()
    terminal.focus()
  } catch (error) {
    terminal.dispose()
    form.busy = false
    const problem = describeProblem(error)
    if (view === 'new') form.problem = problem
    else sessionProblem = problem
    render()
  }
}

async function start(): Promise<void> {
  if (form.folder === null) {
    form.problem = { kind: 'cli-failed', message: 'Elige la carpeta donde trabaja el agente.', hint: null }
    render()
    return
  }
  await launch(request())
}

function dismiss(id: number): void {
  const row = rows.get(id)
  if (row === undefined || !canDismiss(row.info)) return
  rememberDismissed(row.info)
  row.view.dispose()
  rows.delete(id)
  if (selected === id) selected = null
  render()
}

async function loadResume(): Promise<void> {
  form.resumeTicket += 1
  const ticket = form.resumeTicket
  try {
    const list = await api.bitaSessions(form.resumeHere ? form.folder : null)
    if (ticket !== form.resumeTicket) return
    form.resumeList = list
  } catch {
    if (ticket !== form.resumeTicket) return
    form.resumeList = []
  }
  if (view === 'new') render()
}

async function loadForm(): Promise<void> {
  const [dirs, catalog] = await Promise.allSettled([api.bitaDirs(), loadProjects()])
  if (catalog.status === 'fulfilled') {
    form.projects = catalog.value
    fillProjects()
  }
  if (dirs.status === 'fulfilled') {
    form.dirs = dirs.value
    const first = dirs.value[0]
    if (form.folder === null && first !== undefined) chooseFolder(first.cwd, first.projectId)
  } else if (form.problem === null) {
    form.problem = describeProblem(dirs.reason)
  }
  await loadResume()
  if (view === 'new') render()
}

async function restore(): Promise<void> {
  try {
    const list = await api.listAgents()
    pruneDismissed(list)
    const dismissed = readDismissed()
    for (const info of list) {
      if (rows.has(info.id) || isDismissed(info, dismissed)) continue
      const terminal = makeView(() => info.id)
      const row = attachRow(info, terminal)
      try {
        row.info = await api.attachAgent(info.id, (bytes) => terminal.write(bytes))
      } catch (error) {
        sessionProblem = describeProblem(error)
      }
    }
  } catch {
    loaded = true
    render()
    return
  }
  loaded = true
  resolveEntry()
  render()
}

function resolveEntry(): void {
  if (pendingEntry === null) return
  const match = model.sessionForEntry(
    ordered().map((row) => row.info),
    pendingEntry,
  )
  if (match === null) return
  pendingEntry = null
  selected = match.id
  view = 'session'
  pane = model.DEFAULT_PANE
}

function applyPath(path: readonly string[]): void {
  const next = model.parseAgentesPath(path)
  sessionProblem = null
  if (next.kind === 'entry') {
    pendingEntry = next.entryId
    view = 'session'
    resolveEntry()
  } else if (next.kind === 'new') {
    view = 'new'
    form.problem = null
    void loadForm()
  } else if (next.kind === 'mosaic') {
    view = 'mosaic'
  } else {
    view = 'session'
    if (next.id !== null && rows.has(next.id)) selected = next.id
    if (loaded && rows.size === 0) {
      view = 'new'
      void loadForm()
    }
  }
  render()
}

function tick(): void {
  const now = new Date()
  for (const node of root.querySelectorAll<HTMLElement>('[data-clock]')) {
    const started = node.dataset['clock']
    if (started !== undefined) node.textContent = model.shortClock(model.elapsed(started, now))
  }
}

function refreshRow(row: Row): void {
  const id = String(row.info.id)
  const tab = tabs.querySelector<HTMLElement>(`.agentes-tab[data-session="${id}"]`)
  if (tab === null) {
    renderTabs()
  } else {
    fillTab(tab, row)
  }
  const session = body.querySelector<HTMLElement>(`.agentes-session[data-session="${id}"]`)
  if (session !== null) {
    session.querySelector('.agentes-lanes')?.replaceWith(laneNav(row))
    session.querySelector('.agentes-main')?.setAttribute('aria-label', model.sessionTitle(row.info))
    composer.disabled = !row.info.alive
    session.querySelector('.agentes-composer-actions')?.replaceChildren(...composerActions(row))
  }
  const tile = body.querySelector<HTMLElement>(`.agentes-tile[data-session="${id}"]`)
  if (tile !== null) {
    const title = tile.querySelector('.agentes-tile-title')
    if (title !== null) title.textContent = model.sessionTitle(row.info)
    tile.querySelector('.agentes-tile-clock')?.replaceWith(clockFor(row.info, 'agentes-tile-clock'))
    const meta = tile.querySelector('.agentes-tile-meta')
    if (meta !== null) meta.textContent = model.sessionMeta(row.info, projectName)
  }
}

function onAgent(info: AgentInfo): void {
  const row = rows.get(info.id)
  if (row === undefined) return
  row.info = info
  const before = { view, selected, pane }
  resolveEntry()
  if (before.view !== view || before.selected !== selected || before.pane !== pane) render()
  else refreshRow(row)
}

promptBox.addEventListener('input', () => {
  const preview = root.querySelector('.agentes-preview')
  if (preview !== null) preview.textContent = model.commandPreview(request())
})
projectSelect.addEventListener('change', () => render())
composer.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' || event.isComposing) return
  event.preventDefault()
  const text = composer.value
  if (selected === null || text.trim() === '') return
  composer.value = ''
  void api.sendAgent(selected, text).catch((error: unknown) => {
    sessionProblem = describeProblem(error)
    render()
  })
})

export function mount(target: HTMLElement, path: readonly string[]): void {
  host = target
  form = freshForm()
  fillProjects()
  target.replaceChildren(root)
  applyPath(path)
  void restore()
}

export function update(path: readonly string[]): void {
  applyPath(path)
}

export function unmount(): void {
  for (const row of rows.values()) row.view.dispose()
  rows.clear()
  host = null
  loaded = false
  selected = null
  pendingEntry = null
  view = 'session'
  pane = model.DEFAULT_PANE
  sessionProblem = null
  root.remove()
}

export function receive(event: ShellEvent): void {
  if (event.type === 'agent') onAgent(event.info)
  else if (event.type === 'snapshot') tick()
  else if (event.type === 'tools' && rows.size === 0) render()
  else if (event.type === 'hidden') for (const row of rows.values()) row.view.hide()
  else if (event.type === 'visible') placeTerminals()
}
