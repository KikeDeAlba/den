import {
  amendTimer,
  describeProblem,
  discardTimer,
  installHint,
  liveState,
  pending,
  projects,
  startTimer,
  stopTimer,
  type LiveTimer,
  type LiveView,
  type Modules,
  type Problem,
  type Project,
  type Snapshot,
} from '../../bita.ts'
import { element } from '../../dom.ts'
import { clock, human } from '../../format.ts'
import { assistantRow, liveMatches, proposalsCard } from '../../live-panel.ts'
import { moduleEnabled, shellState } from '../../shell/hub.ts'
import { go } from '../../shell/routes.ts'
import type { ShellEvent } from '../section.ts'
import { LAUNCH_KINDS, timerKindFor, type LaunchKind } from './launch.ts'
import { editForm, timerRow, type Draft } from './timers.ts'
import './ahora.css'

const root = element('div', 'ahora')

const total = element('span', 'ahora-total', '—')
const head = element('div', 'ahora-head')
head.append(element('h1', 'ahora-title', 'Ahora'), element('span', 'ahora-total-label', 'hoy'), total)

const launcher = document.createElement('form')
launcher.className = 'ahora-launch'
const launchLabel = element('label', 'visually-hidden', 'Título del cronómetro') as HTMLLabelElement
launchLabel.htmlFor = 'ahora-launch-title'
const launchTitle = document.createElement('input')
launchTitle.id = 'ahora-launch-title'
launchTitle.type = 'text'
launchTitle.autocomplete = 'off'
launchTitle.spellcheck = false
launchTitle.placeholder = '¿En qué trabajas?'
const kindGroup = element('div', 'ahora-kinds')
kindGroup.setAttribute('role', 'radiogroup')
kindGroup.setAttribute('aria-label', 'Tipo')
const kindButtons = new Map<LaunchKind, HTMLButtonElement>()
for (const choice of LAUNCH_KINDS) {
  const button = element('button', undefined, choice.label) as HTMLButtonElement
  button.type = 'button'
  button.setAttribute('role', 'radio')
  button.addEventListener('click', () => pickKind(choice.kind))
  kindButtons.set(choice.kind, button)
  kindGroup.append(button)
}
const enter = element('button', 'tag ahora-enter', '⏎') as HTMLButtonElement
enter.type = 'submit'
enter.setAttribute('aria-label', 'Arrancar')
launcher.append(launchLabel, launchTitle, kindGroup, enter)

const body = element('div', 'ahora-body')
root.append(head, launcher, body)

let latest: Snapshot = { running: [], todaySeconds: 0, problem: null }
let catalog: Project[] = []
let live: LiveView | null = null
let unlogged: number | null = null
let launchKind: LaunchKind = 'work'
let editing: number | null = null
let draft: Draft = { title: '', project: '', kind: '', confirmingDiscard: false }
let failure: Problem | null = null
let busy = false
let painted = ''
let started = false

function enabled(module: keyof Modules): boolean {
  return moduleEnabled(shellState().tools, module)
}

function pickKind(kind: LaunchKind): void {
  launchKind = kind
  for (const [value, button] of kindButtons) button.setAttribute('aria-checked', String(value === kind))
}

function applyModules(): void {
  const meetings = enabled('meetingKinds')
  const meetingButton = kindButtons.get('meeting')
  if (meetingButton !== undefined) meetingButton.hidden = !meetings
  kindGroup.hidden = !meetings
  if (!meetings && launchKind !== 'work') pickKind('work')
  launcher.hidden = !enabled('timers') || editing !== null
}

function problemBlock(problem: Problem): HTMLElement {
  const box = element('div', 'problem')
  box.append(element('p', 'problem-message', problem.message))
  if (problem.hint !== null) box.append(element('code', 'problem-hint', problem.hint))
  return box
}

function missingBita(): HTMLElement {
  const box = element('div', 'empty')
  box.append(element('p', 'empty-title', 'Para medir el tiempo hace falta bita'))
  box.append(element('p', 'empty-note', 'Den conecta las herramientas que tengas instaladas. Esta se instala así:'))
  box.append(element('code', 'problem-hint', installHint(shellState().tools, 'bita')))
  const open = element('button', 'ghost-button', 'Ver las herramientas') as HTMLButtonElement
  open.type = 'button'
  open.addEventListener('click', () => go('ajustes'))
  box.append(open)
  return box
}

function repaint(): void {
  painted = ''
  paint()
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
    applyModules()
    repaint()
  }
}

function startEditing(timer: LiveTimer): void {
  editing = timer.id
  draft = {
    title: timer.title ?? '',
    project: timer.projectId === null ? '' : String(timer.projectId),
    kind: timer.kind ?? '',
    confirmingDiscard: false,
  }
  applyModules()
  repaint()
}

function stopEditing(): void {
  editing = null
  applyModules()
}

function save(timer: LiveTimer): void {
  const title = draft.title.trim()
  const project = draft.project === '' ? null : draft.project
  const previous = timer.kind ?? ''
  const kind = draft.kind === previous ? null : draft.kind === '' ? 'none' : draft.kind
  if (title === '' && project === null && kind === null) {
    failure = { kind: 'cli-failed', message: 'Ponle al menos un título o un proyecto.', hint: null }
    repaint()
    return
  }
  stopEditing()
  void act(() => amendTimer(timer.id, title === '' ? null : title, project, kind))
}

function runningList(): HTMLElement {
  const list = element('section', 'ahora-running')
  list.setAttribute('aria-label', 'Corriendo')
  list.append(element('span', 'ahora-label', `Corriendo · ${latest.running.length}`))
  for (const timer of latest.running) {
    const item = element('div', 'ahora-item')
    item.append(
      timerRow(timer, {
        stop: (target) => void act(() => stopTimer(target.id)).then(() => loadUnlogged()),
        rename: startEditing,
        open: go,
      }),
    )
    if (live !== null && liveMatches(timer, live)) item.append(assistantRow(live))
    if (editing === timer.id) {
      item.append(
        editForm(timer, draft, catalog, enabled('meetingKinds'), {
          discard: (target) => {
            stopEditing()
            void act(() => discardTimer(target.id))
          },
          cancel: () => {
            stopEditing()
            repaint()
          },
          save,
          confirmDiscard: () => {
            draft.confirmingDiscard = true
            repaint()
          },
        }),
      )
    }
    list.append(item)
  }
  return list
}

function jiraLine(): HTMLElement | null {
  if (unlogged === null || unlogged === 0) return null
  const line = element('p', 'ahora-jira', `${unlogged} ${unlogged === 1 ? 'worklog' : 'worklogs'} sin registrar en Jira · `)
  const see = element('button', 'quiet-link', 'ver') as HTMLButtonElement
  see.type = 'button'
  see.addEventListener('click', () => go('tiempo'))
  line.append(see)
  return line
}

function render(): void {
  body.replaceChildren()
  const proposals = shellState().proposals
  for (const meeting of proposals) body.append(proposalsCard(meeting))

  if (!enabled('timers')) {
    body.append(missingBita())
    return
  }
  if (latest.problem !== null) {
    body.append(problemBlock(latest.problem))
    return
  }
  if (failure !== null) body.append(problemBlock(failure))

  if (latest.running.length === 0) {
    const empty = element('div', 'empty')
    empty.append(element('p', 'empty-title', 'El reloj está parado'))
    empty.append(element('p', 'empty-note', `Hoy has medido ${human(latest.todaySeconds)}.`))
    body.append(empty)
  } else {
    body.append(runningList())
    if (latest.running.length > 1) {
      body.append(element('p', 'ahora-note', `${latest.running.length} cronómetros a la vez: hoy suman más que el reloj.`))
    }
  }
  const jira = jiraLine()
  if (jira !== null) body.append(jira)
}

function signature(): string {
  if (latest.problem !== null) return `problem:${latest.problem.message}`
  const timers = latest.running
    .map(
      (timer) =>
        `${timer.id}:${timer.draft}:${timer.title}:${timer.projectName}:${timer.kind}:${timer.sectionsWritten}/${timer.sectionsTotal}`,
    )
    .join('|')
  const assist =
    live === null || live.active === null
      ? 'off'
      : `${live.active.meetingId}:${live.entryId}:${live.answers.length}:${live.transcript.length > 0}`
  const changes = shellState()
    .proposals.map((meeting) => `${meeting.entryId}:${meeting.proposals.length}`)
    .join('|')
  const timersOn = enabled('timers')
  return `${timers}::${editing}::${draft.confirmingDiscard}::${failure?.message ?? ''}::${assist}::${changes}::${unlogged}::${timersOn}`
}

function tickClocks(): void {
  for (const timer of latest.running) {
    const face = body.querySelector<HTMLElement>(`[data-clock="${timer.id}"]`)
    if (face !== null) face.textContent = clock(timer.elapsedSeconds)
  }
}

function paint(): void {
  total.textContent = human(latest.todaySeconds)
  const next = signature()
  if (next === painted) {
    tickClocks()
    return
  }
  painted = next
  render()
}

async function loadCatalog(): Promise<void> {
  if (!enabled('timers')) return
  try {
    catalog = await projects()
  } catch {
    catalog = []
  }
}

async function loadLive(): Promise<void> {
  if (!enabled('liveAssistant')) {
    live = null
    paint()
    return
  }
  try {
    live = await liveState()
  } catch {
    live = null
  }
  paint()
}

async function loadUnlogged(): Promise<void> {
  if (!enabled('jira') || !enabled('timers')) {
    unlogged = null
    paint()
    return
  }
  try {
    const summary = await pending()
    unlogged = summary.groups.reduce((count, group) => count + group.entryIds.length, 0)
  } catch {
    unlogged = null
  }
  paint()
}

function refreshAll(): void {
  void loadCatalog()
  void loadLive()
  void loadUnlogged()
}

launcher.addEventListener('submit', (event) => {
  event.preventDefault()
  const title = launchTitle.value.trim()
  const kind = timerKindFor(launchKind)
  launchTitle.value = ''
  pickKind('work')
  void act(() => startTimer(title === '' ? null : title, null, kind))
})

export function mount(host: HTMLElement): void {
  host.replaceChildren(root)
  latest = shellState().snapshot
  if (!started) {
    started = true
    pickKind('work')
  }
  applyModules()
  repaint()
  refreshAll()
}

export function update(): void {
  repaint()
}

export function unmount(): void {
  editing = null
}

export function receive(event: ShellEvent): void {
  switch (event.type) {
    case 'snapshot':
      latest = event.snapshot
      paint()
      return
    case 'tools':
      applyModules()
      refreshAll()
      repaint()
      return
    case 'proposals':
      paint()
      return
    case 'live-state':
      void loadLive()
      return
    case 'live-transcript': {
      if (live === null || live.active?.meetingId !== event.update.meetingId) return
      live.transcript = event.update.transcript
      paint()
      return
    }
    case 'visible':
      void loadUnlogged()
      return
    case 'docs-changed':
      return
  }
}
