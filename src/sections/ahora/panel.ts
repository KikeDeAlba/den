import {
  addProject,
  amendTimer,
  describeProblem,
  discardTimer,
  isMeetingKind,
  MEETING_KINDS,
  liveState,
  notesToday,
  onDocsChanged,
  onToolsChanged,
  toolsStatus,
  onLiveState,
  onLiveTranscript,
  pendingProposals,
  onSnapshot,
  pending,
  projects,
  jiraProjects,
  jiraKeyMap,
  noJiraSet,
  refresh,
  scopes,
  setScope,
  snapshot,
  startTimer,
  stopTimer,
  unsetScope,
  worked,
  type LiveTimer,
  type LiveView,
  type NoteRow,
  type PendingMeeting,
  type Problem,
  type Project,
  type Scope,
  type Snapshot,
  type WorkedView,
  type ToolsStatus,
  installHint,
} from '../../bita.ts'
import { element, icon, iconButton } from '../../dom.ts'
import { clock, human, startedAt } from '../../format.ts'
import { timerDoc, todayNotes } from '../../notes-panel.ts'
import { assistantRow, liveMatches, proposalsCard } from '../../live-panel.ts'
import { projectColor, renderPending, renderRepos, renderWorked } from '../../tabs.ts'
import { go } from '../../shell/routes.ts'

const TABS = ['ahora', 'hoy', 'jira', 'repos'] as const

type Tab = (typeof TABS)[number]

function tabButton(name: Tab, label: string): HTMLButtonElement {
  const button = element('button', undefined, label) as HTMLButtonElement
  button.type = 'button'
  button.setAttribute('role', 'tab')
  button.dataset['tab'] = name
  button.setAttribute('aria-selected', String(name === 'ahora'))
  return button
}

function kindButton(kind: string, label: string): HTMLButtonElement {
  const button = element('button', undefined, label) as HTMLButtonElement
  button.type = 'button'
  button.setAttribute('role', 'radio')
  button.dataset['kind'] = kind
  button.setAttribute('aria-checked', String(kind === ''))
  return button
}

const root = element('div', 'ahora')
const head = element('div', 'ahora-head')
const todayTotal = element('span', 'bar-total', '—')
head.append(element('span', 'bar-label', 'Hoy'), todayTotal)

const tabStrip = element('nav', 'tabs')
tabStrip.setAttribute('role', 'tablist')
tabStrip.setAttribute('aria-label', 'Vistas')
tabStrip.append(tabButton('ahora', 'Ahora'), tabButton('hoy', 'Hoy'), tabButton('jira', 'Jira'), tabButton('repos', 'Repos'))

const view = element('main', 'view')

const launcher = element('footer', 'launcher')
const launchForm = document.createElement('form')
launchForm.className = 'launcher-row'
const launchLabel = element('label', 'visually-hidden', 'Título del cronómetro') as HTMLLabelElement
launchLabel.htmlFor = 'launch-title'
const launchTitle = document.createElement('input')
launchTitle.id = 'launch-title'
launchTitle.type = 'text'
launchTitle.autocomplete = 'off'
launchTitle.spellcheck = false
launchTitle.placeholder = '¿En qué trabajas?'
const launchGo = document.createElement('button')
launchGo.type = 'submit'
launchGo.className = 'go'
launchGo.setAttribute('aria-label', 'Arrancar')
launchGo.append(icon('play', 13))
launchForm.append(launchLabel, launchTitle, launchGo)
const launchKind = element('div', 'kind-picker')
launchKind.setAttribute('role', 'radiogroup')
launchKind.setAttribute('aria-label', 'Tipo de cronómetro')
launchKind.append(
  kindButton('', 'Trabajo'),
  kindButton('remote-meeting', 'Reunión remota'),
  kindButton('in-person-meeting', 'Presencial'),
)
const launchBlank = element('button', 'quiet-link', 'o arranca en blanco') as HTMLButtonElement
launchBlank.type = 'button'
launcher.append(launchForm, launchKind, launchBlank)

root.append(head, tabStrip, view, launcher)

let tab: Tab = 'ahora'
let latest: Snapshot = { running: [], todaySeconds: 0, problem: null }
let catalog: Project[] = []
let scopeList: Scope[] = []
let workedRange: 'today' | 'week' = 'today'
let editing: number | null = null
let draftTitle = ''
let draftProject = ''
let draftKind = ''
let launchKindValue = ''
let confirmingDiscard = false
let failure: Problem | null = null
let painted = ''
let busy = false
let started = false
let notesOfToday: NoteRow[] = []
let live: LiveView | null = null
let proposals: PendingMeeting[] = []
let tools: ToolsStatus | null = null

function enabled(module: keyof ToolsStatus['modules']): boolean {
  return tools === null || tools.modules[module]
}

const TAB_MODULE: Record<Exclude<Tab, 'ahora'>, keyof ToolsStatus['modules']> = {
  hoy: 'hoy',
  jira: 'jira',
  repos: 'timers',
}

function visibleTabs(): Tab[] {
  return TABS.filter((name) => name === 'ahora' || enabled(TAB_MODULE[name]))
}

function applyModules(): void {
  for (const button of tabStrip.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
    const name = button.dataset['tab'] ?? ''
    button.hidden = !isTab(name) || !visibleTabs().includes(name)
  }
  tabStrip.hidden = visibleTabs().length < 2
  for (const button of launchKind.querySelectorAll<HTMLButtonElement>('[data-kind]')) {
    button.hidden = button.dataset['kind'] !== '' && !enabled('meetingKinds')
  }
  launchKind.hidden = !enabled('meetingKinds')
  if (!enabled('meetingKinds') && launchKindValue !== '') setLaunchKind('')
  if (!visibleTabs().includes(tab)) {
    tab = 'ahora'
    for (const button of tabStrip.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      button.setAttribute('aria-selected', String(button.dataset['tab'] === 'ahora'))
    }
  }
}

function missingBita(): HTMLElement {
  const box = element('div', 'empty')
  box.append(element('p', 'empty-title', 'Para medir el tiempo hace falta bita'))
  box.append(element('p', 'empty-note', 'Den conecta las herramientas que tengas instaladas. Esta se instala así:'))
  box.append(element('code', 'problem-hint', installHint(tools, 'bita')))
  const open = element('button', 'ghost-button wide', 'Ver las herramientas') as HTMLButtonElement
  open.type = 'button'
  open.addEventListener('click', () => go('ajustes'))
  box.append(open)
  return box
}

function isTab(value: string): value is Tab {
  return (TABS as readonly string[]).includes(value)
}

function signature(): string {
  if (latest.problem !== null) return `problem:${latest.problem.message}`
  const timers = latest.running
    .map(
      (timer) =>
        `${timer.id}:${timer.draft}:${timer.title}:${timer.projectName}:${timer.kind}:${timer.sectionsWritten}/${timer.sectionsTotal}:${timer.touchedSinceNote}`,
    )
    .join('|')
  const notes = notesOfToday
    .map((row) => `${row.entryId}:${row.doc?.sectionCount ?? -1}`)
    .join('|')
  const assist =
    live === null || live.active === null
      ? 'off'
      : `${live.active.meetingId}:${live.entryId}:${live.answers.length}:${live.transcript.length > 0}`
  const changes = proposals.map((meeting) => `${meeting.entryId}:${meeting.proposals.length}`).join('|')
  return `${timers}::${notes}::${editing}::${failure?.message ?? ''}::${confirmingDiscard}::${assist}::${changes}`
}

async function act(run: () => Promise<Snapshot>): Promise<void> {
  if (busy) return
  busy = true
  failure = null
  try {
    latest = await run()
  } catch (error) {
    failure = describeProblem(error)
  } finally {
    busy = false
    painted = ''
    paint()
  }
}

function busyView(): void {
  view.replaceChildren(element('p', 'placeholder', 'Preguntando al CLI…'))
}

function failureView(error: unknown): void {
  const problem = describeProblem(error)
  view.replaceChildren()
  const box = element('div', 'problem')
  box.append(element('p', 'problem-message', problem.message))
  if (problem.hint !== null) box.append(element('code', 'problem-hint', problem.hint))
  view.append(box)
}

function stopButton(timer: LiveTimer): HTMLButtonElement {
  const button = iconButton('stop', 'stop', `Parar el cronómetro ${timer.id}`)
  button.addEventListener('click', () => void act(() => stopTimer(timer.id)))
  return button
}

function projectPill(timer: LiveTimer): HTMLElement {
  if (timer.projectName === null) {
    return element('span', 'pill pill--empty', 'sin proyecto')
  }
  const pill = element('span', 'pill')
  const dot = element('i', 'dot')
  dot.style.background = projectColor(timer.projectId)
  pill.append(dot, element('span', undefined, timer.projectName))
  return pill
}

function timerCard(timer: LiveTimer): HTMLElement {
  const card = element('article', timer.draft ? 'timer timer--draft' : 'timer')
  card.dataset['id'] = String(timer.id)

  const title = element('p', 'timer-title')
  if (timer.draft) {
    title.append(element('span', 'timer-unnamed', 'Sin nombre todavía'))
    title.append(element('span', 'timer-id', `#${timer.id}`))
  } else {
    title.textContent = timer.title ?? ''
  }
  card.append(title)
  if (isMeetingKind(timer.kind)) card.append(meetingBadge(timer.kind))

  const row = element('div', 'timer-row')
  row.append(projectPill(timer))
  row.append(element('span', 'timer-since', `desde ${startedAt(timer.startLocal)}`))

  const face = element('span', 'timer-clock', clock(timer.elapsedSeconds))
  face.dataset['clock'] = String(timer.id)
  row.append(face, stopButton(timer))
  card.append(row)

  if (live !== null && liveMatches(timer, live)) card.append(assistantRow(live))

  const doc = timerDoc(timer)
  if (doc !== null) card.append(doc)

  if (editing === timer.id) {
    card.append(editForm(timer))
  } else if (timer.draft) {
    const name = element('button', 'wide-button', 'Ponerle nombre') as HTMLButtonElement
    name.type = 'button'
    name.addEventListener('click', () => {
      editing = timer.id
      draftTitle = timer.title ?? ''
      draftProject = timer.projectId === null ? '' : String(timer.projectId)
      draftKind = timer.kind ?? ''
      confirmingDiscard = false
      painted = ''
      paint()
    })
    card.append(name)
  }

  return card
}

function meetingBadge(kind: keyof typeof MEETING_KINDS): HTMLElement {
  const badge = element('p', 'timer-kind')
  badge.append(element('i', 'rec-dot'), element('span', undefined, MEETING_KINDS[kind]))
  return badge
}

function setLaunchKind(value: string): void {
  launchKindValue = value
  for (const button of launchKind.querySelectorAll<HTMLButtonElement>('[data-kind]')) {
    button.setAttribute('aria-checked', String(button.dataset['kind'] === value))
  }
}

function editForm(timer: LiveTimer): HTMLElement {
  const form = element('div', 'edit')

  const titleField = element('label', 'field')
  titleField.append(element('span', 'field-label', 'Título'))
  const input = document.createElement('input')
  input.type = 'text'
  input.value = draftTitle
  input.placeholder = '¿En qué has estado?'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.addEventListener('input', () => {
    draftTitle = input.value
  })
  titleField.append(input)
  form.append(titleField)

  const projectField = element('label', 'field')
  projectField.append(element('span', 'field-label', 'Proyecto'))
  const select = document.createElement('select')
  const none = document.createElement('option')
  none.value = ''
  none.textContent = 'Dejarlo sin proyecto'
  select.append(none)
  for (const project of catalog) {
    const option = document.createElement('option')
    option.value = String(project.id)
    option.textContent = project.name
    select.append(option)
  }
  select.value = draftProject
  select.addEventListener('change', () => {
    draftProject = select.value
  })
  projectField.append(select)
  form.append(projectField)

  const kindField = element('label', 'field')
  kindField.append(element('span', 'field-label', 'Tipo'))
  const kindSelect = document.createElement('select')
  const kinds = enabled('meetingKinds') || isMeetingKind(draftKind) ? Object.entries(MEETING_KINDS) : []
  for (const [value, label] of [['', 'Trabajo'], ...kinds]) {
    const option = document.createElement('option')
    option.value = value ?? ''
    option.textContent = label ?? ''
    kindSelect.append(option)
  }
  if (draftKind !== '' && !isMeetingKind(draftKind)) {
    const option = document.createElement('option')
    option.value = draftKind
    option.textContent = draftKind
    kindSelect.append(option)
  }
  kindSelect.value = draftKind
  kindSelect.addEventListener('change', () => {
    draftKind = kindSelect.value
  })
  kindField.append(kindSelect)
  form.append(kindField)

  const actions = element('div', 'edit-actions')

  const discard = element(
    'button',
    'quiet-link quiet-link--danger',
    confirmingDiscard ? '¿Seguro? Se pierde el tiempo' : 'Descartar',
  ) as HTMLButtonElement
  discard.type = 'button'
  discard.addEventListener('click', () => {
    if (!confirmingDiscard) {
      confirmingDiscard = true
      painted = ''
      paint()
      return
    }
    editing = null
    confirmingDiscard = false
    void act(() => discardTimer(timer.id))
  })

  const cancel = element('button', 'ghost-button', 'Cancelar') as HTMLButtonElement
  cancel.type = 'button'
  cancel.addEventListener('click', () => {
    editing = null
    confirmingDiscard = false
    painted = ''
    paint()
  })

  const save = element('button', 'primary-button', 'Guardar') as HTMLButtonElement
  save.type = 'button'
  save.addEventListener('click', () => {
    const title = draftTitle.trim()
    const project = draftProject === '' ? null : draftProject
    const previousKind = timer.kind ?? ''
    const kind = draftKind === previousKind ? null : draftKind === '' ? 'none' : draftKind
    if (title === '' && project === null && kind === null) {
      failure = {
        kind: 'cli-failed',
        message: 'Ponle al menos un título o un proyecto.',
        hint: null,
      }
      painted = ''
      paint()
      return
    }
    editing = null
    confirmingDiscard = false
    void act(() => amendTimer(timer.id, title === '' ? null : title, project, kind))
  })

  actions.append(discard, element('span', 'spacer'), cancel, save)
  form.append(actions)
  return form
}

function problemBlock(problem: Problem): HTMLElement {
  const box = element('div', 'problem')
  box.append(element('p', 'problem-message', problem.message))
  if (problem.hint !== null) box.append(element('code', 'problem-hint', problem.hint))
  return box
}

function renderAhora(): void {
  view.replaceChildren()

  if (!enabled('timers')) {
    for (const meeting of proposals) view.append(proposalsCard(meeting))
    view.append(missingBita())
    return
  }

  if (latest.problem !== null) {
    view.append(problemBlock(latest.problem))
    return
  }

  if (failure !== null) view.append(problemBlock(failure))

  for (const meeting of proposals) view.append(proposalsCard(meeting))

  if (latest.running.length === 0) {
    const empty = element('div', 'empty')
    empty.append(element('p', 'empty-title', 'El reloj está parado'))
    empty.append(element('p', 'empty-note', `Hoy has medido ${human(latest.todaySeconds)}.`))
    view.append(empty)
    const notes = todayNotes(notesOfToday)
    if (notes !== null) view.append(notes)
    return
  }

  const list = element('div', 'timers')
  for (const timer of latest.running) list.append(timerCard(timer))
  view.append(list)

  if (latest.running.length > 1) {
    view.append(
      element(
        'p',
        'note',
        `${latest.running.length} cronómetros a la vez: hoy suman más que el reloj.`,
      ),
    )
  }

  const notes = todayNotes(notesOfToday)
  if (notes !== null) view.append(notes)
}

async function loadTodayNotes(): Promise<void> {
  if (!enabled('entryNotes') || !enabled('timers')) {
    notesOfToday = []
    return
  }
  try {
    const payload = await notesToday()
    notesOfToday = payload.data
  } catch {
    notesOfToday = []
  }
  painted = ''
  paint()
}

async function loadLive(): Promise<void> {
  if (!enabled('liveAssistant')) {
    live = null
    return
  }
  try {
    live = await liveState()
  } catch {
    live = null
  }
  paint()
}

async function loadProposals(): Promise<void> {
  if (!enabled('proposals')) {
    proposals = []
    return
  }
  try {
    proposals = await pendingProposals()
  } catch {
    proposals = []
  }
  paint()
}

function tickClocks(): void {
  for (const timer of latest.running) {
    const face = view.querySelector<HTMLElement>(`[data-clock="${timer.id}"]`)
    if (face !== null) face.textContent = clock(timer.elapsedSeconds)
  }
}

function paint(): void {
  todayTotal.textContent = human(latest.todaySeconds)
  launcher.hidden = tab !== 'ahora' || editing !== null || !enabled('timers')

  if (tab !== 'ahora') return

  const current = signature()
  if (current === painted) {
    tickClocks()
    return
  }
  painted = current
  renderAhora()
}

async function loadWorked(): Promise<void> {
  busyView()
  try {
    const data: WorkedView = await worked(workedRange)
    if (tab !== 'hoy') return
    renderWorked(view, data, workedRange, (next) => {
      workedRange = next
      void loadWorked()
    })
  } catch (error) {
    if (tab === 'hoy') failureView(error)
  }
}

async function loadPending(): Promise<void> {
  busyView()
  try {
    const data = await pending()
    if (tab === 'jira') renderPending(view, data)
  } catch (error) {
    if (tab === 'jira') failureView(error)
  }
}

async function loadRepos(): Promise<void> {
  busyView()
  try {
    const mapped = enabled('jira') ? jiraProjects().catch(() => []) : Promise.resolve([])
    const [nextScopes, nextCatalog, jira] = await Promise.all([scopes(), projects(), mapped])
    scopeList = nextScopes
    catalog = nextCatalog
    if (tab !== 'repos') return
    renderRepos(
      view,
      scopeList,
      catalog,
      {
        onAddProject: (name) => void reposAction(() => addProject(name), 'projects'),
        onAddScope: (prefix, project) => void reposAction(() => setScope(prefix, project), 'scopes'),
        onRemoveScope: (prefix) => void reposAction(() => unsetScope(prefix), 'scopes'),
      },
      jiraKeyMap(jira),
      noJiraSet(jira),
    )
  } catch (error) {
    if (tab === 'repos') failureView(error)
  }
}

async function reposAction(
  run: () => Promise<Project[] | Scope[]>,
  kind: 'projects' | 'scopes',
): Promise<void> {
  if (busy) return
  busy = true
  try {
    const result = await run()
    if (kind === 'projects') catalog = result as Project[]
    else scopeList = result as Scope[]
    busy = false
    await loadRepos()
  } catch (error) {
    busy = false
    failureView(error)
  }
}

function showTab(next: Tab): void {
  tab = visibleTabs().includes(next) ? next : 'ahora'
  applyModules()
  painted = ''
  launcher.hidden = tab !== 'ahora' || !enabled('timers')
  next = tab
  if (next === 'ahora') {
    paint()
    return
  }
  if (next === 'hoy') void loadWorked()
  if (next === 'jira') void loadPending()
  if (next === 'repos') void loadRepos()
}

async function start(): Promise<void> {
  const tabs = tabStrip.querySelectorAll<HTMLButtonElement>('[role="tab"]')
  for (const button of tabs) {
    button.addEventListener('click', () => {
      const name = button.dataset['tab']
      if (name === undefined || !isTab(name)) return
      for (const other of tabs) other.setAttribute('aria-selected', String(other === button))
      showTab(name)
    })
  }

  launchForm.addEventListener('submit', (event) => {
    event.preventDefault()
    const title = launchTitle.value.trim()
    const kind = launchKindValue === '' ? null : launchKindValue
    launchTitle.value = ''
    setLaunchKind('')
    void act(() => startTimer(title === '' ? null : title, null, kind))
  })

  launchBlank.addEventListener('click', () => {
    const kind = launchKindValue === '' ? null : launchKindValue
    launchTitle.value = ''
    setLaunchKind('')
    void act(() => startTimer(null, null, kind))
  })

  for (const button of launchKind.querySelectorAll<HTMLButtonElement>('[data-kind]')) {
    button.addEventListener('click', () => setLaunchKind(button.dataset['kind'] ?? ''))
  }

  onSnapshot((value) => {
    latest = value
    paint()
  })

  onDocsChanged(() => {
    void loadTodayNotes()
    void loadProposals()
  })

  onLiveState(() => {
    void loadLive()
    void loadProposals()
  })

  onLiveTranscript((update) => {
    if (live === null || live.active?.meetingId !== update.meetingId) return
    const hadLines = live.transcript.length > 0
    live.transcript = update.transcript
    if (!hadLines) paint()
  })

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void loadProposals()
  })

  onToolsChanged((status) => {
    applyTools(status)
  })

  latest = await snapshot()
  paint()

  try {
    tools = await toolsStatus()
  } catch {
    tools = null
  }
  applyModules()

  try {
    latest = await refresh()
  } catch (error) {
    latest = { running: [], todaySeconds: 0, problem: describeProblem(error) }
  }
  paint()

  const nothing = tools !== null && !tools.modules.timers && !tools.modules.notes && !tools.modules.meetings
  if (nothing || (enabled('timers') && latest.problem !== null)) {
    go('ajustes')
    return
  }

  if (enabled('timers')) {
    try {
      catalog = await projects()
    } catch {
      catalog = []
    }
  }

  void loadTodayNotes()
  void loadLive()
  void loadProposals()
}

function applyTools(status: ToolsStatus): void {
  tools = status
  applyModules()
  painted = ''
  void loadTodayNotes()
  void loadLive()
  void loadProposals()
  showTab(tab)
}

export function mountPanel(host: HTMLElement): void {
  host.replaceChildren(root)
  if (started) {
    showTab(tab)
    return
  }
  started = true
  void start().catch((error: unknown) => failureView(error))
}

export function refreshPanel(): void {
  if (started) showTab(tab)
}
