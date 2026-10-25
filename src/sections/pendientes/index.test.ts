import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BacklogItem, Space } from '../../bita.ts'

const api = vi.hoisted(() => ({
  toolsStatus: vi.fn(),
  notesTree: vi.fn(),
  backlogList: vi.fn(),
  backlogSetKind: vi.fn(),
  backlogSetStatus: vi.fn(),
  backlogAdd: vi.fn(),
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

function item(id: number, fields: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id,
    key: `VC-${id}`,
    kind: 'pending',
    status: 'open',
    title: `Item ${id}`,
    body: '',
    resolution: '',
    createdAt: '2026-10-20T10:00:00Z',
    resolvedAt: null,
    projectId: 1,
    projectName: 'Viva Cash',
    pageId: null,
    pageTitle: null,
    entryId: null,
    source: 'manual',
    updatedAt: '2026-10-20T10:00:00Z',
    ...fields,
  }
}

const SPACE = {
  projectId: 1,
  projectName: 'Viva Cash',
  projectSlug: 'viva',
  active: true,
  entryCount: 0,
  pageCount: 1,
  pages: [{ pageId: 5, title: 'API', meetings: [{ entryId: 9 }], children: [] }],
} as unknown as Space

const ITEMS = [
  item(1, { kind: 'finding', pageId: 5, pageTitle: 'API' }),
  item(2, { source: 'extracted', entryId: 9, pageId: 5, pageTitle: 'API' }),
  item(3, { source: 'extracted', entryId: 12 }),
]

function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 20))
}

function titles(host: HTMLElement): string[] {
  return [...host.querySelectorAll('.pend-row-title')].map((node) => node.textContent ?? '')
}

describe('pendientes section', () => {
  let host: HTMLElement
  let section: typeof import('./index.ts')

  beforeEach(async () => {
    localStorage.clear()
    vi.resetModules()
    api.toolsStatus.mockResolvedValue({ modules: { backlog: true } })
    api.notesTree.mockResolvedValue({ data: { spaces: [SPACE] } })
    api.backlogList.mockResolvedValue({ data: ITEMS })
    api.backlogSetKind.mockImplementation((id: number, kind: string) => Promise.resolve({ data: { ...ITEMS.find((it) => it.id === id), kind } }))
    host = document.createElement('section')
    document.body.append(host)
    section = await import('./index.ts')
    await section.mount(host, ['viva'])
    await flush()
  })

  afterEach(() => {
    section.unmount()
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('shows where each item came from', () => {
    const origins = [...host.querySelectorAll('.pend-row-origin')].map((node) => node.textContent)
    expect(origins.sort()).toEqual(['Extraída', 'Manual', 'Reunión'])
  })

  it('filters by origin from the compact filter strip', () => {
    host.querySelector<HTMLButtonElement>('.pend-filter')?.click()
    const selects = [...host.querySelectorAll<HTMLSelectElement>('.pend-filter-select')]
    expect(selects).toHaveLength(5)
    const origin = selects[3] as HTMLSelectElement
    origin.value = 'meeting'
    origin.dispatchEvent(new Event('change'))
    expect(titles(host)).toEqual(['Item 2'])
    expect(host.querySelector('.pend-badge')?.textContent).toBe('1')
  })

  it('keeps the filter badge in step after switching to a space without that page', async () => {
    const other = { ...SPACE, projectId: 2, projectName: 'Otro', projectSlug: 'otro', pages: [] } as unknown as Space
    api.notesTree.mockResolvedValue({ data: { spaces: [SPACE, other] } })
    api.backlogList.mockResolvedValue({
      data: [...ITEMS, item(7, { key: 'OT-7', projectId: 2, projectName: 'Otro', title: 'Otro 7' })],
    })
    section.receive({ type: 'docs-changed' })
    await flush()
    host.querySelector<HTMLButtonElement>('.pend-filter')?.click()
    const pick = (index: number, value: string) => {
      const select = host.querySelectorAll<HTMLSelectElement>('.pend-filter-select')[index] as HTMLSelectElement
      select.value = value
      select.dispatchEvent(new Event('change'))
    }
    pick(2, '5')
    pick(1, 'pending')
    expect(titles(host)).toEqual(['Item 2'])
    expect(host.querySelector('.pend-badge')?.textContent).toBe('2')
    section.update(['otro'])
    await flush()
    expect(titles(host)).toEqual(['Otro 7'])
    expect(host.querySelector('.pend-badge')?.textContent).toBe('1')
    const page = host.querySelectorAll<HTMLSelectElement>('.pend-filter-select')[2]
    expect(page?.value).toBe('all')
  })

  it('keeps focus on the filters and grouping buttons after they repaint', () => {
    const filters = host.querySelector<HTMLButtonElement>('.pend-filter') as HTMLButtonElement
    filters.focus()
    filters.click()
    expect(host.querySelector('#pend-filters')).not.toBeNull()
    expect(document.activeElement).toBe(host.querySelector('.pend-filter'))
    const grouping = host.querySelector<HTMLButtonElement>('.pend-grouping') as HTMLButtonElement
    grouping.focus()
    grouping.click()
    expect(host.querySelector('.pend-grouping')).not.toBe(grouping)
    expect(document.activeElement).toBe(host.querySelector('.pend-grouping'))
  })

  it('groups the list by page', () => {
    host.querySelector<HTMLButtonElement>('.pend-grouping')?.click()
    const labels = [...host.querySelectorAll('.pend-group-label')].map((node) => node.textContent)
    expect(labels).toEqual(['API · 2', 'Sin página · 1'])
  })

  it('converts a pending into a finding and a finding into a pending', async () => {
    section.update(['viva', 'VC-2'])
    await flush()
    const toFinding = host.querySelector<HTMLButtonElement>('.pend-convert')
    expect(toFinding?.textContent).toBe('Convertir en hallazgo')
    toFinding?.click()
    await flush()
    expect(api.backlogSetKind).toHaveBeenCalledWith(2, 'finding')
    section.update(['viva', 'VC-1'])
    await flush()
    const toPending = host.querySelector<HTMLButtonElement>('.pend-convert')
    expect(toPending?.textContent).toBe('Convertir en pendiente')
    toPending?.click()
    await flush()
    expect(api.backlogSetKind).toHaveBeenCalledWith(1, 'pending')
  })

  it('keeps focus and the typed draft when the docs change', async () => {
    host.querySelector<HTMLButtonElement>('.pend-new')?.click()
    const title = host.querySelector<HTMLInputElement>('.pend-form-title') as HTMLInputElement
    title.focus()
    title.value = 'Revisar'
    title.dispatchEvent(new Event('input'))
    section.receive({ type: 'docs-changed' })
    await flush()
    expect(host.querySelector('.pend-form-title')).toBe(title)
    expect(document.activeElement).toBe(title)

    api.backlogList.mockResolvedValue({ data: [...ITEMS, item(4)] })
    section.receive({ type: 'docs-changed' })
    await flush()
    const again = host.querySelector<HTMLInputElement>('.pend-form-title')
    expect(again?.value).toBe('Revisar')
    expect(document.activeElement).toBe(again)
  })

  it('ignores an older backlog answer that lands after a newer one', async () => {
    let releaseOld: (value: unknown) => void = () => undefined
    api.backlogList.mockImplementationOnce(() => new Promise((done) => (releaseOld = done)))
    api.backlogList.mockResolvedValueOnce({ data: [...ITEMS, item(5, { title: 'Nuevo' })] })
    section.receive({ type: 'docs-changed' })
    await flush()
    section.receive({ type: 'docs-changed' })
    await flush()
    releaseOld({ data: [item(1, { title: 'Viejo' })] })
    await flush()
    expect(titles(host)).toContain('Nuevo')
    expect(titles(host)).not.toContain('Viejo')
  })
})
