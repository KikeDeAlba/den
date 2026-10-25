import { describeProblem, doctorReport, liveState, snapshot, type LiveView, type Snapshot } from '../../bita.ts'
import { element } from '../../dom.ts'
import { renderLiveSettings } from '../../live-panel.ts'
import { renderSettings } from '../../settings.ts'
import { go } from '../../shell/routes.ts'
import './ajustes.css'

const ASSISTANT = 'asistente'
const DEFAULT_SHORTCUT = 'Ctrl+Alt+Space'

let view: HTMLElement | null = null
let shown: string | null = null
let ticket = 0

function problem(target: HTMLElement, error: unknown): void {
  const box = element('div', 'problem')
  const found = describeProblem(error)
  box.append(element('p', 'problem-message', found.message))
  if (found.hint !== null) box.append(element('code', 'problem-hint', found.hint))
  target.replaceChildren(box)
}

async function showTools(target: HTMLElement, mine: number): Promise<void> {
  target.replaceChildren(element('p', 'placeholder', 'Preguntando al CLI…'))
  try {
    const report = await doctorReport()
    if (mine !== ticket) return
    renderSettings(
      target,
      report,
      () => go('ahora'),
      () => paint([], true),
      () => go(`ajustes/${ASSISTANT}`),
    )
  } catch (error) {
    if (mine === ticket) problem(target, error)
  }
}

function projectOf(live: LiveView | null, current: Snapshot | null): string | null {
  return live?.project ?? current?.running.find((timer) => timer.projectName !== null)?.projectName ?? null
}

async function showAssistant(target: HTMLElement, mine: number): Promise<void> {
  const [live, current] = await Promise.all([
    liveState().catch(() => null),
    snapshot().catch(() => null),
  ])
  if (mine !== ticket) return
  renderLiveSettings(target, live?.shortcut ?? DEFAULT_SHORTCUT, projectOf(live, current), () => go('ajustes'))
}

function paint(path: readonly string[], force = false): void {
  if (view === null) return
  const key = path[0] === ASSISTANT ? ASSISTANT : ''
  if (!force && key === shown) return
  shown = key
  ticket += 1
  if (key === ASSISTANT) void showAssistant(view, ticket)
  else void showTools(view, ticket)
}

export function mount(host: HTMLElement, path: readonly string[]): void {
  view = element('div', 'ajustes')
  host.replaceChildren(view)
  shown = null
  paint(path)
}

export function update(path: readonly string[]): void {
  paint(path)
}

export function unmount(): void {
  view = null
  shown = null
}
