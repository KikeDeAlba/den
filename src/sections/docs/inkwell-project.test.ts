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
  pageDocument: vi.fn(),
  meetingForEntry: vi.fn(),
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

const MEETING = { entryId: 9, kind: 'meeting', startedAt: '2026-10-20T10:00:00Z', stoppedAt: null, durationSeconds: 60 }

const PAGE = {
  pageId: 5,
  parentId: null,
  projectId: 4,
  projectName: 'DP Caja de pagos',
  projectSlug: 'dp-caja-de-pagos',
  slug: 'api',
  title: 'API',
  relPath: 'api.md',
  byteSize: 10,
  issues: [],
  meetings: [MEETING],
  recordedAt: '2026-10-20T10:00:00Z',
  status: 'active',
  entryCount: 0,
  durationSeconds: 0,
  durationHuman: '0m',
  sectionCount: 0,
  headingCount: 0,
  childCount: 0,
  depth: 0,
  position: 0,
  ancestors: [],
  children: [],
  doc: {
    path: '/docs/api.md',
    relPath: 'api.md',
    markdown: '# API',
    frontMatter: {},
    frontMatterValid: true,
    preamble: '',
    outline: [],
    file: { status: 'ok', path: '/docs/api.md', checksum: null, recordedChecksum: '', byteSize: 10, recordedByteSize: 10, mtime: null },
  },
  entries: [],
  worklogIssues: [],
}

const VIEW = {
  id: 'm-9',
  title: 'Revisión',
  mode: 'remote',
  status: 'done',
  dir: '/tmp/m-9',
  startedAt: '2026-10-20T10:00:00Z',
  durationSeconds: 60,
  recording: null,
  summaryMarkdown: null,
  segments: [],
  frames: [],
  hasVideo: false,
  storage: null,
  video: null,
  videoRemovedAt: null,
  answers: [],
  proposals: [
    { n: 1, pageId: 5, pageTitle: 'API', section: null, title: 'Agregar timeout', rationale: null, quotes: [], branch: null, sha: null, status: 'pending', appliedSha: null },
  ],
}

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
    api.pageDocument.mockResolvedValue({ data: PAGE, meta: {} })
    api.meetingForEntry.mockResolvedValue(VIEW)
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

  it('checks the confluence links of a meeting proposal with the inkwell key, not the name', async () => {
    section.update(['dp-caja-de-pagos', '5'])
    await flush()
    api.confluenceSyncStatus.mockClear()
    const tab = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes('Cambios propuestos'))
    expect(tab).toBeDefined()
    tab?.click()
    await flush()
    expect(api.confluenceSyncStatus).toHaveBeenCalledWith('CDP')
    expect(api.confluenceSyncStatus).not.toHaveBeenCalledWith('DP Caja de pagos')
  })
})
