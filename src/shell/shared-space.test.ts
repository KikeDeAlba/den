import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Space } from '../bita.ts'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
})

const api = vi.hoisted(() => ({
  notesTree: vi.fn(),
  backlogList: vi.fn(),
  toolsStatus: vi.fn(),
  brains: [] as Array<{ load: ReturnType<typeof vi.fn> }>,
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.reject(new Error('offline'))),
  convertFileSrc: (path: string) => path,
  Channel: class {},
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
  emit: vi.fn(() => Promise.resolve()),
}))

vi.mock('../bita.ts', async (original) => ({
  ...(await original<typeof import('../bita.ts')>()),
  notesTree: api.notesTree,
  backlogList: api.backlogList,
  toolsStatus: api.toolsStatus,
}))

vi.mock('../sections/cerebro/brain.ts', () => ({
  createBrain: vi.fn(() => {
    const brain = {
      load: vi.fn(() => Promise.resolve()),
      failed: () => false,
      focusSearch: () => undefined,
      hasSelection: () => false,
      openNote: () => undefined,
      noteOpen: () => false,
      deselect: () => undefined,
      dispose: vi.fn(),
    }
    api.brains.push(brain)
    return brain
  }),
}))

import { NO_MODULES } from '../bita.ts'

type SpaceModule = typeof import('./space.ts')
type DocsModule = typeof import('../sections/docs/index.ts')
type PendientesModule = typeof import('../sections/pendientes/index.ts')
type CerebroModule = typeof import('../sections/cerebro/index.ts')

let docs: DocsModule
let pendientes: PendientesModule
let cerebro: CerebroModule
let rememberedSpace: SpaceModule['rememberedSpace']
let rememberSpace: SpaceModule['rememberSpace']

function space(projectSlug: string, projectName: string): Space {
  return { projectId: projectSlug.length, projectName, projectSlug, active: true, entryCount: 0, pageCount: 1, pages: [] }
}

function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 20))
}

describe('the space shared by Docs, Pendientes and Cerebro', () => {
  let hosts: Record<'docs' | 'pendientes' | 'cerebro', HTMLElement>

  beforeEach(async () => {
    localStorage.clear()
    api.brains.length = 0
    api.notesTree.mockResolvedValue({ data: { spaces: [space('alpha', 'Alpha'), space('beta', 'Beta')] } })
    api.backlogList.mockResolvedValue({ data: [] })
    api.toolsStatus.mockResolvedValue({ modules: { ...NO_MODULES, notes: true, backlog: true } })
    vi.resetModules()
    const shared = await import('./space.ts')
    rememberedSpace = shared.rememberedSpace
    rememberSpace = shared.rememberSpace
    docs = await import('../sections/docs/index.ts')
    pendientes = await import('../sections/pendientes/index.ts')
    cerebro = await import('../sections/cerebro/index.ts')
    await shared.loadSpaces(true)
    hosts = { docs: document.createElement('section'), pendientes: document.createElement('section'), cerebro: document.createElement('section') }
    document.body.append(hosts.docs, hosts.pendientes, hosts.cerebro)
  })

  afterEach(() => {
    docs.unmount()
    pendientes.unmount()
    cerebro.unmount()
    document.body.replaceChildren()
  })

  it('shows in Pendientes the space chosen in Docs', async () => {
    await docs.mount(hosts.docs, ['alpha'])
    await pendientes.mount(hosts.pendientes, [])
    await flush()
    expect(hosts.pendientes.querySelector('.pend-space-name')?.textContent).toBe('Alpha')
    rememberSpace('beta')
    await flush()
    expect(hosts.pendientes.querySelector('.pend-space-name')?.textContent).toBe('Beta')
    expect(rememberedSpace()).toBe('beta')
  })

  it('opens Cerebro on the space of a Docs deep link', async () => {
    await docs.mount(hosts.docs, ['beta'])
    await flush()
    expect(rememberedSpace()).toBe('beta')
    await cerebro.mount(hosts.cerebro, [])
    expect(api.brains[0]?.load).toHaveBeenCalledWith('beta')
  })

  it('shares the space of a Pendientes deep link with the rest of the shell', async () => {
    await pendientes.mount(hosts.pendientes, ['beta'])
    await flush()
    expect(rememberedSpace()).toBe('beta')
    await cerebro.mount(hosts.cerebro, [])
    expect(api.brains[0]?.load).toHaveBeenCalledWith('beta')
  })

  it('shares a Pendientes deep link to the space it already shows', async () => {
    await pendientes.mount(hosts.pendientes, ['beta'])
    await flush()
    pendientes.unmount()
    localStorage.clear()
    expect(rememberedSpace()).toBeNull()
    await pendientes.mount(hosts.pendientes, ['beta'])
    await flush()
    expect(rememberedSpace()).toBe('beta')
    pendientes.update(['beta'])
    await flush()
    expect(rememberedSpace()).toBe('beta')
  })

  it('carries a space picked in Cerebro back to the sections that stay alive', async () => {
    await docs.mount(hosts.docs, ['alpha'])
    await pendientes.mount(hosts.pendientes, ['alpha'])
    await cerebro.mount(hosts.cerebro, ['alpha'])
    await flush()
    cerebro.update(['beta'])
    await flush()
    expect(rememberedSpace()).toBe('beta')
    expect(hosts.pendientes.querySelector('.pend-space-name')?.textContent).toBe('Beta')
  })

  it('ignores an unknown space instead of blanking the other sections', async () => {
    await pendientes.mount(hosts.pendientes, ['alpha'])
    await flush()
    rememberSpace('gone')
    await flush()
    expect(hosts.pendientes.querySelector('.pend-space-name')?.textContent).toBe('Alpha')
  })

  it('stops following the space after Pendientes is unmounted', async () => {
    await pendientes.mount(hosts.pendientes, ['alpha'])
    await flush()
    pendientes.unmount()
    expect(() => rememberSpace('beta')).not.toThrow()
  })
})
