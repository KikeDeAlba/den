import type { LiveTimer, Snapshot } from '../bita.ts'
import { element } from '../dom.ts'
import { clock } from '../format.ts'
import { go } from './routes.ts'

export interface Topbar {
  element: HTMLElement
  title(text: string): void
  show(snapshot: Snapshot): void
}

export function leaderOf(running: readonly LiveTimer[]): LiveTimer | null {
  let leader: LiveTimer | null = null
  for (const timer of running) {
    if (
      leader === null ||
      timer.startedAt < leader.startedAt ||
      (timer.startedAt === leader.startedAt && timer.id < leader.id)
    ) {
      leader = timer
    }
  }
  return leader
}

function dragRegion(node: HTMLElement): HTMLElement {
  node.setAttribute('data-tauri-drag-region', '')
  return node
}

export function buildTopbar(): Topbar {
  const bar = dragRegion(element('header', 'topbar'))
  const heading = dragRegion(element('span', 'topbar-title'))
  const spacer = dragRegion(element('span', 'topbar-spacer'))

  const leader = document.createElement('button')
  leader.type = 'button'
  leader.className = 'leader'
  leader.addEventListener('click', () => go('ahora'))
  const dot = element('i', 'leader-dot')
  const name = element('span', 'leader-name')
  const extra = element('span', 'leader-extra')
  const face = element('span', 'leader-clock')
  leader.append(dot, name, extra, face)

  bar.append(heading, spacer, leader)

  return {
    element: bar,
    title(text) {
      heading.textContent = text
    },
    show(snapshot) {
      const top = leaderOf(snapshot.running)
      leader.dataset['idle'] = String(top === null)
      if (top === null) {
        name.textContent = 'Sin cronómetro'
        extra.textContent = ''
        face.textContent = ''
        leader.setAttribute('aria-label', 'Ningún cronómetro corriendo; ir a Ahora')
        return
      }
      const label = top.title ?? (top.draft ? 'Sin nombre' : (top.projectName ?? 'Cronómetro'))
      name.textContent = label
      const others = snapshot.running.length - 1
      extra.textContent = others > 0 ? `+${others}` : ''
      face.textContent = clock(top.elapsedSeconds)
      leader.setAttribute('aria-label', `${label}, ${face.textContent}; ir a Ahora`)
    },
  }
}
