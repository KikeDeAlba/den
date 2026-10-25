import { describe, expect, it } from 'vitest'
import type { BacklogItem, Space } from '../../bita.ts'
import { activeFilters, defaultFilters, groupByPage, meetingEntryIds, originOf, otherKind, pagesOf, passes } from './model.ts'

function item(id: number, fields: Partial<BacklogItem> = {}): BacklogItem {
  return {
    id,
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

const NOW = new Date('2026-10-25T12:00:00Z')

describe('pendientes filters', () => {
  it('tells meeting, extracted and manual items apart', () => {
    const meetings = new Set([40])
    expect(originOf(item(1, { entryId: 40, source: 'extracted' }), meetings)).toBe('meeting')
    expect(originOf(item(2, { entryId: 41, source: 'extracted' }), meetings)).toBe('extracted')
    expect(originOf(item(3), meetings)).toBe('manual')
  })

  it('collects meeting entries from nested pages', () => {
    const page = (pageId: number, entryIds: number[], children: unknown[] = []) =>
      ({ pageId, meetings: entryIds.map((entryId) => ({ entryId })), children }) as never
    const space = { pages: [page(1, [7], [page(2, [8])])] } as unknown as Space
    expect([...meetingEntryIds([space])].sort()).toEqual([7, 8])
  })

  it('filters by status, kind, page, origin and creation date', () => {
    const items = [
      item(1, { kind: 'finding', pageId: 5, pageTitle: 'API', createdAt: '2026-10-25T09:00:00Z' }),
      item(2, { status: 'resolved', createdAt: '2026-09-01T09:00:00Z' }),
      item(3, { source: 'extracted', entryId: 9, pageId: 5, pageTitle: 'API', createdAt: '2026-10-21T09:00:00Z' }),
    ]
    const ids = (filters: ReturnType<typeof defaultFilters>) =>
      items.filter((candidate) => passes(candidate, filters, NOW, new Set([9]))).map((candidate) => candidate.id)
    const base = defaultFilters()
    expect(ids(base)).toEqual([1, 2, 3])
    expect(ids({ ...base, status: 'open' })).toEqual([1, 3])
    expect(ids({ ...base, kind: 'finding' })).toEqual([1])
    expect(ids({ ...base, page: '5' })).toEqual([1, 3])
    expect(ids({ ...base, page: 'none' })).toEqual([2])
    expect(ids({ ...base, origin: 'meeting' })).toEqual([3])
    expect(ids({ ...base, created: 'today' })).toEqual([1])
    expect(ids({ ...base, created: 'week' })).toEqual([1, 3])
    expect(ids({ ...base, created: 'old' })).toEqual([2])
    expect(activeFilters({ ...base, kind: 'finding', created: 'old' })).toBe(2)
    expect(activeFilters(base)).toBe(0)
  })

  it('groups by page with the pageless group last', () => {
    const groups = groupByPage([
      item(1),
      item(2, { pageId: 5, pageTitle: 'API', createdAt: '2026-10-21T10:00:00Z' }),
      item(3, { pageId: 6, pageTitle: 'Login', createdAt: '2026-10-22T10:00:00Z' }),
    ])
    expect(groups.map((group) => group.label)).toEqual(['Login', 'API', 'Sin página'])
    expect(pagesOf([item(1), item(2, { pageId: 5, pageTitle: 'API' })]).map((page) => page.label)).toEqual(['API', 'Sin página'])
  })

  it('converts in both directions', () => {
    expect(otherKind('finding')).toBe('pending')
    expect(otherKind('pending')).toBe('finding')
  })
})
