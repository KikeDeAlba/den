import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
})

const core = vi.hoisted(() => ({
  invoke: vi.fn((_command: string, _args?: unknown) => Promise.reject(new Error('offline'))),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: core.invoke,
  convertFileSrc: (path: string) => path,
  Channel: class {},
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
  emit: vi.fn(() => Promise.resolve()),
}))

import type { SectionModule } from './section.ts'

const CASES: Array<[string, () => Promise<SectionModule>, string]> = [
  ['docs', () => import('./docs/index.ts'), 'notes_tree'],
  ['pendientes', () => import('./pendientes/index.ts'), 'backlog_list'],
  ['reuniones', () => import('./reuniones/index.ts'), 'recap_list'],
]

function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 20))
}

function calls(command: string): number {
  return core.invoke.mock.calls.filter(([name]) => name === command).length
}

describe.each(CASES)('%s when the window shows again', (_id, load, command) => {
  let host: HTMLElement
  let module: SectionModule

  beforeEach(async () => {
    localStorage.clear()
    core.invoke.mockClear()
    host = document.createElement('section')
    document.body.append(host)
    module = await load()
    await module.mount(host, [])
    await flush()
  })

  afterEach(() => {
    module.unmount()
    document.body.replaceChildren()
  })

  it('reloads its data on visible', async () => {
    const before = calls(command)
    module.receive?.({ type: 'visible' })
    await flush()
    expect(calls(command)).toBeGreaterThan(before)
  })

  it('does not reload while hidden', async () => {
    const before = calls(command)
    module.receive?.({ type: 'hidden' })
    await flush()
    expect(calls(command)).toBe(before)
  })
})
