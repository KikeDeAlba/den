import { describeProblem, onNavigate } from '../bita.ts'
import { GAZE_FIXTURE } from '../cerebro/flag.ts'
import { element } from '../dom.ts'
import { isMac, os } from '../platform.ts'
import type { SectionModule, ShellEvent } from '../sections/section.ts'
import { needsSetup, shellState, startHub } from './hub.ts'
import { createSections } from './sections.ts'
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
import { railMarks, visibleSections } from './visibility.ts'

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

const rail = buildRail()
const topbar = buildTopbar()
const content = element('main', 'content')

function failure(host: HTMLElement, error: unknown): void {
  const box = element('div', 'problem')
  box.append(element('p', 'problem-message', describeProblem(error).message))
  host.replaceChildren(box)
}

const sections = createSections(content, LOADERS, failure)

function show(route: Route): void {
  rememberSection(route.section)
  rail.select(route.section)
  topbar.title(sectionLabel(route.section))
  void sections.show(route)
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

function paintRail(): void {
  const state = shellState()
  rail.reveal(visibleSections(state.tools, GAZE_FIXTURE))
  const marks = railMarks(state.snapshot, state.proposals)
  rail.mark('ahora', marks.ahora)
  rail.mark('docs', marks.docs)
  rail.mark('reuniones', marks.reuniones)
}

function broadcast(event: ShellEvent): void {
  if (event.type === 'snapshot') topbar.show(event.snapshot)
  if (event.type === 'snapshot' || event.type === 'tools' || event.type === 'proposals') paintRail()
  sections.broadcast(event)
}

async function boot(): Promise<void> {
  await startHub(broadcast)
  if (sections.current() === 'ahora' && needsSetup(shellState())) go('ajustes')
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
  void boot()
}

start()
