import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Space } from '../bita.ts'

const api = vi.hoisted(() => ({
  atlassianSites: vi.fn(),
  confluenceSyncStatus: vi.fn(),
  confluenceSync: vi.fn(),
  projectAtlassian: vi.fn(),
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
  ...api,
}))

const SPACE = {
  projectId: 4,
  projectKey: 'CDP',
  projectName: 'DP Caja de pagos',
  projectSlug: 'dp-caja-de-pagos',
  active: true,
  entryCount: 0,
  pageCount: 0,
  pages: [],
  atlassian: {
    site: 'acme',
    confluence: { kind: 'space', url: 'https://acme.atlassian.net/wiki/spaces/CDP', spaceKey: 'CDP' },
    sync: { pull: true, push: false, lastSyncAt: null },
  },
} as unknown as Space

function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 20))
}

describe('space settings', () => {
  let host: HTMLElement
  let settings: typeof import('./space-settings.ts')

  beforeEach(async () => {
    vi.resetModules()
    api.atlassianSites.mockResolvedValue([])
    api.confluenceSyncStatus.mockResolvedValue([])
    api.confluenceSync.mockResolvedValue([])
    host = document.createElement('section')
    document.body.append(host)
    settings = await import('./space-settings.ts')
    settings.renderSpaceSettings(host, {
      space: SPACE,
      clientName: null,
      jiraKey: null,
      railOpen: true,
      onExpandRail: () => undefined,
      onManageConnections: () => undefined,
      onSaved: () => undefined,
      available: { atlassian: true, meetings: true },
    })
    await flush()
  })

  afterEach(() => {
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('reads the confluence mappings with the inkwell key, not the slug', () => {
    expect(api.confluenceSyncStatus).toHaveBeenCalledWith('CDP')
    expect(api.confluenceSyncStatus).not.toHaveBeenCalledWith('dp-caja-de-pagos')
  })

  it('syncs the space with the inkwell key, not the slug', async () => {
    const sync = [...host.querySelectorAll<HTMLButtonElement>('button')].find((node) => node.textContent?.includes('Sincronizar ahora'))
    expect(sync).toBeDefined()
    sync?.click()
    await flush()
    expect(api.confluenceSync).toHaveBeenCalledWith('CDP')
  })
})
