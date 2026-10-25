import { liveState, type LiveView } from '../../bita.ts'
import { element } from '../../dom.ts'
import { renderLiveSettings } from '../../live-panel.ts'
import { moduleEnabled, shellState } from '../../shell/hub.ts'
import { go } from '../../shell/routes.ts'
import type { ShellEvent } from '../section.ts'
import { menubarBlock } from './menubar.ts'
import { reposBlock } from './repos.ts'
import { shortcutsBlock } from './shortcuts.ts'
import { toolsBlock } from './tools.ts'
import './ajustes.css'

const ASSISTANT = 'asistente'
const DEFAULT_SHORTCUT = 'Ctrl+Alt+Space'

const enabled = (module: Parameters<typeof moduleEnabled>[1]): boolean => moduleEnabled(shellState().tools, module)

const tools = toolsBlock()
const repos = reposBlock(() => enabled('jira'))
const menubar = menubarBlock()
const shortcuts = shortcutsBlock(
  () => enabled('liveAssistant'),
  () => go(`ajustes/${ASSISTANT}`),
)

const page = element('div', 'ajustes')
page.append(element('h1', 'ajustes-title', 'Ajustes'), tools.element, repos.element, menubar.element, shortcuts.element)

const assistantView = element('div', 'ajustes ajustes--assistant')

let host: HTMLElement | null = null
let shown: string | null = null
let ticket = 0

function projectOf(live: LiveView | null): string | null {
  return live?.project ?? shellState().snapshot.running.find((timer) => timer.projectName !== null)?.projectName ?? null
}

async function showAssistant(mine: number): Promise<void> {
  const live = await liveState().catch(() => null)
  if (mine !== ticket) return
  renderLiveSettings(assistantView, live?.shortcut ?? DEFAULT_SHORTCUT, projectOf(live), () => go('ajustes'))
}

function applyModules(): void {
  repos.element.hidden = !enabled('timers')
}

function loadPage(): void {
  applyModules()
  void tools.load()
  if (enabled('timers')) void repos.load()
  void menubar.load()
  void shortcuts.load()
}

function paint(path: readonly string[]): void {
  if (host === null) return
  const key = path[0] === ASSISTANT ? ASSISTANT : ''
  if (key === shown) return
  shown = key
  ticket += 1
  if (key === ASSISTANT) {
    host.replaceChildren(assistantView)
    void showAssistant(ticket)
    return
  }
  host.replaceChildren(page)
  loadPage()
}

export function mount(target: HTMLElement, path: readonly string[]): void {
  host = target
  shown = null
  paint(path)
}

export function update(path: readonly string[]): void {
  paint(path)
}

export function unmount(): void {
  host = null
  shown = null
}

export function receive(event: ShellEvent): void {
  if (event.type !== 'tools' || shown !== '') return
  loadPage()
}
