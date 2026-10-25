import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.reject(new Error('offline'))),
  convertFileSrc: (path: string) => path,
  Channel: class {},
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
  emit: vi.fn(() => Promise.resolve()),
}))

vi.mock('./cerebro/brain.ts', () => ({
  createBrain: vi.fn(() => ({
    load: () => Promise.resolve(),
    failed: () => false,
    focusSearch: () => undefined,
    hasSelection: () => false,
    openNote: () => undefined,
    noteOpen: () => false,
    deselect: () => undefined,
    dispose: () => undefined,
  })),
}))

import type { SectionModule } from './section.ts'
import type { SectionId } from '../shell/routes.ts'

const LOADERS: Record<SectionId, () => Promise<SectionModule>> = {
  ahora: () => import('./ahora/index.ts'),
  agentes: () => import('./agentes/index.ts'),
  tiempo: () => import('./tiempo/index.ts'),
  docs: () => import('./docs/index.ts'),
  pendientes: () => import('./pendientes/index.ts'),
  reuniones: () => import('./reuniones/index.ts'),
  cerebro: () => import('./cerebro/index.ts'),
  ajustes: () => import('./ajustes/index.ts'),
}

type Target = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

interface Tally {
  added: Map<string, number>
  removed: Map<string, number>
}

function watch(target: Target): Tally {
  const tally: Tally = { added: new Map(), removed: new Map() }
  const add = target.addEventListener.bind(target)
  const remove = target.removeEventListener.bind(target)
  const bump = (map: Map<string, number>, type: string): void => void map.set(type, (map.get(type) ?? 0) + 1)
  vi.spyOn(target, 'addEventListener').mockImplementation(((type: string, ...rest: [EventListenerOrEventListenerObject, ...unknown[]]) => {
    const options = rest[1]
    const scoped = typeof options === 'object' && options !== null && 'signal' in options
    if (!scoped) bump(tally.added, type)
    add(type, ...(rest as [EventListenerOrEventListenerObject]))
  }) as typeof target.addEventListener)
  vi.spyOn(target, 'removeEventListener').mockImplementation(((type: string, ...rest: [EventListenerOrEventListenerObject, ...unknown[]]) => {
    bump(tally.removed, type)
    remove(type, ...(rest as [EventListenerOrEventListenerObject]))
  }) as typeof target.removeEventListener)
  return tally
}

function open(tally: Tally): number {
  let total = 0
  for (const [type, count] of tally.added) total += count - (tally.removed.get(type) ?? 0)
  return total
}

function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 20))
}

const IDS = Object.keys(LOADERS) as SectionId[]

describe.each(IDS)('%s mount cycle', (id) => {
  let host: HTMLElement

  beforeEach(() => {
    localStorage.clear()
    host = document.createElement('section')
    document.body.append(host)
  })

  afterEach(() => {
    host.remove()
    document.body.replaceChildren()
  })

  const leaks = id === 'docs' ? it.fails : it
  leaks('mounts and unmounts repeatedly without growing its global listeners', async () => {
    const module = await LOADERS[id]()
    const onWindow = watch(window)
    const onDocument = watch(document)
    const counts: number[] = []
    for (let round = 0; round < 3; round += 1) {
      await module.mount(host, [])
      await flush()
      module.unmount()
      await flush()
      counts.push(open(onWindow) + open(onDocument))
    }
    expect(counts[2]).toBeLessThanOrEqual(counts[0] ?? 0)
  })

  it('survives events and a path update after unmount', async () => {
    const module = await LOADERS[id]()
    await module.mount(host, [])
    await flush()
    module.unmount()
    expect(() => {
      module.receive?.({ type: 'docs-changed' })
      module.receive?.({ type: 'hidden' })
      module.receive?.({ type: 'visible' })
      module.receive?.({ type: 'sync-finished' })
      module.receive?.({ type: 'live-state' })
    }).not.toThrow()
    await flush()
  })

  it('leaves no pending dialogs or popovers behind', async () => {
    const module = await LOADERS[id]()
    await module.mount(host, [])
    await flush()
    module.unmount()
    expect(document.querySelectorAll('.switcher, [role="dialog"]')).toHaveLength(0)
  })
})

describe('only cerebro frees its host on leave', () => {
  it.each(IDS)('%s declares its keepAlive', async (id) => {
    const module = await LOADERS[id]()
    expect(module.keepAlive !== false).toBe(id !== 'cerebro')
  })
})
