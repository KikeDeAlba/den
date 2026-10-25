import { describeProblem, onNavigate, onSnapshot, snapshot } from '../bita.ts'
import { element } from '../dom.ts'
import { isMac, os } from '../platform.ts'
import type { SectionModule } from '../sections/section.ts'
import { rememberedSection, rememberSection } from './memory.ts'
import { buildRail } from './rail.ts'
import {
  DEFAULT_SECTION,
  formatRoute,
  go,
  parseRoute,
  sectionLabel,
  shortcutSection,
  type Route,
  type SectionId,
} from './routes.ts'
import { buildTopbar } from './topbar.ts'

const LOADERS: Record<SectionId, () => Promise<SectionModule>> = {
  ahora: () => import('../sections/ahora/index.ts'),
  agentes: () => import('../sections/agentes/index.ts'),
  tiempo: () => import('../sections/tiempo/index.ts'),
  docs: () => import('../sections/docs/index.ts'),
  pendientes: () => import('../sections/pendientes/index.ts'),
  reuniones: () => import('../sections/reuniones/index.ts'),
  cerebro: () => import('../sections/cerebro/index.ts'),
  ajustes: () => import('../sections/ajustes/index.ts'),
}

interface Mounted {
  host: HTMLElement
  module: SectionModule | null
}

const rail = buildRail()
const topbar = buildTopbar()
const content = element('main', 'content')
const mounted = new Map<SectionId, Mounted>()
let current: SectionId | null = null

function failure(host: HTMLElement, error: unknown): void {
  const box = element('div', 'problem')
  box.append(element('p', 'problem-message', describeProblem(error).message))
  host.replaceChildren(box)
}

function leave(section: SectionId): void {
  const entry = mounted.get(section)
  if (entry === undefined) return
  entry.host.hidden = true
  if (entry.module === null || entry.module.keepAlive !== false) return
  entry.module.unmount()
  entry.host.remove()
  mounted.delete(section)
}

async function load(route: Route): Promise<void> {
  const host = element('section', 'section-host')
  host.dataset['section'] = route.section
  content.append(host)
  const entry: Mounted = { host, module: null }
  mounted.set(route.section, entry)
  try {
    entry.module = await LOADERS[route.section]()
    await entry.module.mount(host, route.path)
  } catch (error) {
    failure(host, error)
  }
  if (current !== route.section) leave(route.section)
}

function show(route: Route): void {
  if (current !== null && current !== route.section) leave(current)
  current = route.section
  rememberSection(route.section)
  rail.select(route.section)
  topbar.title(sectionLabel(route.section))
  document.documentElement.dataset['section'] = route.section

  const entry = mounted.get(route.section)
  if (entry === undefined) {
    void load(route)
    return
  }
  entry.host.hidden = false
  entry.module?.update(route.path)
}

function route(): void {
  const parsed = parseRoute(location.hash)
  if (parsed === null) {
    const fallback = formatRoute({ section: rememberedSection() ?? DEFAULT_SECTION, path: [] })
    history.replaceState(null, '', fallback)
    route()
    return
  }
  show(parsed)
}

function shortcuts(event: KeyboardEvent): void {
  const section = shortcutSection(event, isMac)
  if (section === null) return
  event.preventDefault()
  go(section)
}

async function watchTimers(): Promise<void> {
  onSnapshot((value) => topbar.show(value))
  try {
    topbar.show(await snapshot())
  } catch {
    topbar.show({ running: [], todaySeconds: 0, problem: null })
  }
}

function start(): void {
  document.documentElement.dataset['os'] = os
  const shell = element('div', 'shell')
  shell.append(topbar.element, rail.element, content)
  document.body.replaceChildren(shell)
  topbar.show({ running: [], todaySeconds: 0, problem: null })

  window.addEventListener('hashchange', route)
  window.addEventListener('keydown', shortcuts)
  onNavigate((next) => go(next))
  route()
  void watchTimers()
}

start()
