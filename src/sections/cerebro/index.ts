import { onToolsChanged, type Space } from '../../bita.ts'
import { GAZE_FIXTURE } from '../../cerebro/flag.ts'
import { element, icon } from '../../dom.ts'
import { closeSwitcher, isSwitcherOpen, toggleSwitcher, withPages } from '../../notes/switcher.ts'
import { isMac, modKey } from '../../platform.ts'
import { chooseSpace, loadSpaces, rememberedSpace, rememberSpace } from '../../shell/space.ts'
import { projectColor } from '../../tabs.ts'
import { createBrain, type BrainView } from './brain.ts'
import './cerebro.css'

interface Mounted {
  brain: BrainView
  picker: HTMLButtonElement
  pickerDot: HTMLElement
  pickerName: HTMLElement
  spaces: Space[]
  space: Space | null
  lifetime: AbortController
}

let view: Mounted | null = null
let watching = false

function watchTools(): void {
  if (watching || GAZE_FIXTURE) return
  watching = true
  onToolsChanged(() => {
    if (view?.brain.failed() === true) void view.brain.load(view.space?.projectSlug ?? null)
  })
}

function spaceName(space: Space | null): string {
  if (space === null) return 'Todo el cerebro'
  return space.projectName ?? space.projectSlug
}

function paintPicker(mounted: Mounted): void {
  mounted.pickerName.textContent = spaceName(mounted.space)
  mounted.pickerDot.style.background = mounted.space === null ? 'var(--fg-faint)' : projectColor(mounted.space.projectId)
  mounted.picker.disabled = mounted.spaces.length === 0
}

function useSpace(mounted: Mounted, space: Space | null): void {
  const changed = space?.projectSlug !== mounted.space?.projectSlug
  mounted.space = space
  if (space !== null) rememberSpace(space.projectSlug)
  paintPicker(mounted)
  if (changed) {
    mounted.brain.deselect()
    void mounted.brain.load(space?.projectSlug ?? null)
  }
}

function pickBySlug(mounted: Mounted, slug: string): void {
  const space = mounted.spaces.find((candidate) => candidate.projectSlug === slug)
  if (space !== undefined) useSpace(mounted, space)
}

function togglePicker(mounted: Mounted): void {
  if (mounted.spaces.length === 0) return
  toggleSwitcher({
    anchor: mounted.picker,
    spaces: mounted.spaces,
    active: mounted.space?.projectSlug ?? null,
    onPick: (slug) => pickBySlug(mounted, slug),
  })
}

async function start(mounted: Mounted, wanted: string | null): Promise<void> {
  try {
    mounted.spaces = await loadSpaces()
  } catch {
    mounted.spaces = []
  }
  if (view !== mounted) return
  const space = chooseSpace(mounted.spaces, wanted ?? rememberedSpace())
  mounted.space = space
  if (space !== null) rememberSpace(space.projectSlug)
  paintPicker(mounted)
  await mounted.brain.load(space?.projectSlug ?? null)
}

function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(target.tagName)
}

function keys(mounted: Mounted, event: KeyboardEvent): void {
  if (mounted.brain.noteOpen()) return
  const modifier = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
  const key = event.key.toLowerCase()
  if (modifier && !event.altKey && !event.shiftKey && key === 'k') {
    event.preventDefault()
    togglePicker(mounted)
    return
  }
  if (modifier && isSwitcherOpen() && /^[1-9]$/.test(event.key)) {
    const space = withPages(mounted.spaces)[Number(event.key) - 1]
    event.preventDefault()
    event.stopImmediatePropagation()
    if (space === undefined) return
    closeSwitcher()
    useSpace(mounted, space)
    return
  }
  if (modifier && !event.altKey && !event.shiftKey && key === 'f') {
    event.preventDefault()
    mounted.brain.focusSearch()
    return
  }
  if (isSwitcherOpen() || typing(event.target)) return
  if (event.key === ' ' && !modifier && mounted.brain.hasSelection()) {
    event.preventDefault()
    mounted.brain.openNote()
  } else if (event.key === 'Escape' && mounted.brain.hasSelection()) {
    mounted.brain.deselect()
  }
}

function build(host: HTMLElement): Omit<Mounted, 'spaces' | 'space' | 'lifetime'> {
  const root = element('div', 'brain')
  const area = element('section', 'brain-graph')
  area.setAttribute('aria-label', 'Grafo')

  const stage = element('div', 'brain-stage')
  stage.tabIndex = -1

  const tools = element('div', 'brain-tools')
  const searchBox = element('div', 'brain-search')
  const search = document.createElement('input')
  search.type = 'search'
  search.placeholder = 'Buscar en el cerebro'
  search.autocomplete = 'off'
  search.spellcheck = false
  search.setAttribute('aria-label', 'Buscar en el cerebro')
  search.setAttribute('aria-controls', 'brain-hits')
  search.setAttribute('aria-expanded', 'false')
  const hits = element('div', 'brain-hits')
  hits.id = 'brain-hits'
  hits.setAttribute('role', 'listbox')
  hits.hidden = true
  searchBox.append(icon('search', 12), search, hits)

  const picker = element('button', 'brain-space') as HTMLButtonElement
  picker.type = 'button'
  picker.setAttribute('aria-haspopup', 'dialog')
  picker.setAttribute('aria-expanded', 'false')
  picker.setAttribute('aria-label', 'Cambiar de espacio')
  const pickerDot = element('span', 'dot')
  const pickerName = element('span', 'brain-space-name', 'Todo el cerebro')
  picker.append(pickerDot, pickerName, element('span', 'brain-kbd', modKey('K')), icon('chevronDown', 12))
  tools.append(searchBox, picker)

  const legend = element('div', 'brain-legend')
  legend.hidden = true
  const count = element('span', 'brain-count')
  const message = element('div', 'brain-message')
  message.hidden = true
  area.append(stage, tools, legend, count, message)

  const side = element('aside', 'brain-side')
  side.setAttribute('aria-label', 'Nota elegida')
  root.append(area, side)
  host.replaceChildren(root)

  const brain = createBrain({ root, stage, legend, count, message, side, search, hits })
  return { brain, picker, pickerDot, pickerName }
}

export function mount(host: HTMLElement, path: readonly string[]): Promise<void> {
  unmount()
  const parts = build(host)
  const mounted: Mounted = { ...parts, spaces: [], space: null, lifetime: new AbortController() }
  view = mounted
  paintPicker(mounted)
  parts.picker.addEventListener('click', () => togglePicker(mounted))
  window.addEventListener('keydown', (event) => keys(mounted, event), { capture: true, signal: mounted.lifetime.signal })
  watchTools()
  return start(mounted, path[0] ?? null)
}

export function update(path: readonly string[]): void {
  const slug = path[0]
  if (view === null || slug === undefined) return
  pickBySlug(view, slug)
}

export function unmount(): void {
  if (view === null) return
  const mounted = view
  view = null
  closeSwitcher()
  mounted.lifetime.abort()
  mounted.brain.dispose()
}

export const keepAlive = false
