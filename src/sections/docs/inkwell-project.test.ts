import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Space } from '../../bita.ts'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  })
})

const api = vi.hoisted(() => ({
  toolsStatus: vi.fn(),
  notesTree: vi.fn(),
  notesSearchPages: vi.fn(),
  confluenceSyncStatus: vi.fn(),
  searchTranscripts: vi.fn(),
  projects: vi.fn(),
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

vi.mock('../../bita.ts', async (original) => ({
  ...(await original<typeof import('../../bita.ts')>()),
  ...api,
}))

const SPACE = {
  projectId: 4,
  projectKey: 'CDP',
  projectName: 'DP Caja de pagos',
  projectSlug: 'dp-caja-de-pagos',
  active: true,
  entryCount: 0,
  pageCount: 1,
  pages: [{ pageId: 5, parentId: null, projectId: 4, projectSlug: 'dp-caja-de-pagos', title: 'API', slug: 'api', byteSize: 10, issues: [], meetings: [], children: [] }],
  atlassian: {
    site: 'acme',
    confluence: { kind: 'space', url: 'https://acme.atlassian.net/wiki/spaces/CDP', spaceKey: 'CDP' },
    sync: { pull: true, push: false, lastSyncAt: null },
  },
} as unknown as Space

function flush(ms = 20): Promise<void> {
  return new Promise((done) => setTimeout(done, ms))
}

describe('docs talks to inkwell by project key', () => {
  let host: HTMLElement
  let section: typeof import('./index.ts')

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    api.toolsStatus.mockRejectedValue(new Error('offline'))
    api.notesTree.mockResolvedValue({ data: { spaces: [SPACE] } })
    api.notesSearchPages.mockResolvedValue({ data: [] })
    api.confluenceSyncStatus.mockResolvedValue([])
    api.searchTranscripts.mockResolvedValue([])
    api.projects.mockResolvedValue([])
    host = document.createElement('section')
    host.dataset['section'] = 'docs'
    document.body.append(host)
    section = await import('./index.ts')
    await section.mount(host, [])
    await flush()
  })

  afterEach(() => {
    section.unmount()
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('loads the confluence links with the inkwell key, not the slug', () => {
    expect(api.confluenceSyncStatus).toHaveBeenCalledWith('CDP')
    expect(api.confluenceSyncStatus).not.toHaveBeenCalledWith('dp-caja-de-pagos')
  })

  it('searches the space with the inkwell key, not the slug', async () => {
    const input = host.querySelector<HTMLInputElement>('#rail-query') as HTMLInputElement
    input.value = 'cobro'
    input.dispatchEvent(new Event('input'))
    await flush(250)
    expect(api.notesSearchPages).toHaveBeenCalledWith('cobro', 'CDP')
  })
})
