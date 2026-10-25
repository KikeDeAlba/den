import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
})

const core = vi.hoisted(() => {
  const modules = {
    timers: true,
    hoy: true,
    jira: true,
    notes: true,
    entryNotes: true,
    backlog: true,
    history: true,
    proposals: true,
    atlassian: true,
    confluenceSync: true,
    meetings: true,
    liveAssistant: true,
    autoAsk: true,
    meetingKinds: true,
    graph: true,
    graphSearch: true,
  }
  const page = {
    pageId: 5,
    parentId: null,
    projectId: 1,
    projectName: 'Viva Cash',
    projectSlug: 'viva',
    slug: 'api',
    title: 'Marcador docs',
    relPath: 'viva/api.md',
    depth: 0,
    position: 0,
    status: 'active',
    entryCount: 0,
    durationSeconds: 0,
    durationHuman: '0 min',
    issues: [],
    sectionCount: 0,
    headingCount: 0,
    byteSize: 0,
    recordedAt: '2026-10-20T10:00:00Z',
    childCount: 0,
    meetings: [],
    children: [],
  }
  const space = {
    projectId: 1,
    projectName: 'Viva Cash',
    projectSlug: 'viva',
    active: true,
    entryCount: 0,
    pageCount: 1,
    pages: [page],
  }
  const backlogItem = {
    id: 1,
    key: 'VC-1',
    kind: 'pending',
    status: 'open',
    title: 'Marcador pendiente',
    body: '',
    resolution: '',
    createdAt: '2026-10-20T10:00:00Z',
    resolvedAt: null,
    projectId: 1,
    projectName: 'Viva Cash',
    pageId: 5,
    pageTitle: 'Marcador docs',
    entryId: null,
    source: 'manual',
    updatedAt: '2026-10-20T10:00:00Z',
  }
  const meeting = {
    id: '2026-10-20-1000-marcador',
    title: 'Marcador reunion',
    mode: 'meeting',
    status: 'done',
    createdAt: '2026-10-20T16:00:00Z',
    dir: '/tmp/recap/2026-10-20-1000-marcador',
    hasVideo: false,
    storage: { recordingBytes: 0, intermediateBytes: 0, framesBytes: 0, otherBytes: 0, totalBytes: 0 },
  }
  const answers: Record<string, unknown> = {
    tools_status: { registryDir: '', tools: [], invalid: [], modules, inkwellMigrated: true },
    notes_tree: { data: { projects: [], spaces: [space] }, meta: {} },
    backlog_list: { data: [backlogItem], meta: {} },
    recap_list: [meeting],
  }
  return {
    invoke: vi.fn((command: string, _args?: unknown) =>
      command in answers ? Promise.resolve(answers[command]) : Promise.reject(new Error('offline')),
    ),
  }
})

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

const CASES: Array<[string, () => Promise<SectionModule>, string, string, string[]]> = [
  ['docs', () => import('./docs/index.ts'), 'notes_tree', 'Marcador docs', []],
  ['pendientes', () => import('./pendientes/index.ts'), 'backlog_list', 'Marcador pendiente', ['viva']],
  ['reuniones', () => import('./reuniones/index.ts'), 'recap_list', 'Marcador reunion', []],
]

function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 20))
}

async function settle(): Promise<void> {
  let seen = -1
  while (seen !== core.invoke.mock.calls.length) {
    seen = core.invoke.mock.calls.length
    await flush()
  }
}

function calls(command: string): number {
  return core.invoke.mock.calls.filter(([name]) => name === command).length
}

describe.each(CASES)('%s when the window shows again', (_id, load, command, marker, path) => {
  let host: HTMLElement
  let module: SectionModule

  beforeEach(async () => {
    localStorage.clear()
    core.invoke.mockClear()
    host = document.createElement('section')
    document.body.append(host)
    module = await load()
    await module.mount(host, path)
    await settle()
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
    expect(calls(command)).toBeGreaterThan(0)
    expect(host.textContent).toContain(marker)
    const before = core.invoke.mock.calls.length
    module.receive?.({ type: 'hidden' })
    await flush()
    await flush()
    expect(core.invoke.mock.calls.slice(before)).toEqual([])
    expect(host.textContent).toContain(marker)
  })
})
