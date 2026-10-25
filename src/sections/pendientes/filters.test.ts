import { describe, expect, it } from 'vitest'
import type { BacklogItem, Space } from '../../bita.ts'
import {
  activeFilters,
  daysSince,
  defaultFilters,
  filtersForSpace,
  groupByPage,
  meetingEntryIds,
  originOf,
  otherKind,
  pagesOf,
  passes,
  type CreatedFilter,
} from './model.ts'

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
      item(1, { kind: 'finding', pageId: 5, pageTitle: 'API', createdAt: '2026-10-25T12:00:00Z' }),
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

  it('counts creation days by the local calendar, not by 24-hour spans', () => {
    const now = new Date(2026, 9, 25, 0, 30)
    const at = (year: number, month: number, day: number, hour: number, minute = 0) =>
      new Date(year, month, day, hour, minute).toISOString()
    const created = (createdAt: string, filter: CreatedFilter) =>
      passes(item(1, { createdAt }), { ...defaultFilters(), created: filter }, now, new Set())
    expect(created(at(2026, 9, 25, 0, 0), 'today')).toBe(true)
    expect(created(at(2026, 9, 24, 23, 59), 'today')).toBe(false)
    expect(daysSince(at(2026, 9, 24, 23, 59), now)).toBe(1)
    expect(created(at(2026, 9, 19, 9), 'week')).toBe(true)
    expect(created(at(2026, 9, 18, 23, 59), 'week')).toBe(false)
    expect(created(at(2026, 9, 11, 0, 0), 'old')).toBe(false)
    expect(created(at(2026, 9, 10, 23, 59), 'old')).toBe(true)
    expect(daysSince(at(2026, 9, 10, 23, 59), now)).toBe(15)
    expect(created(at(2026, 9, 26, 9), 'today')).toBe(false)
  })

  it('never counts a broken creation date as today or as old', () => {
    for (const createdAt of ['', 'mañana', '2026-13-45T99:00:00Z']) {
      const created = (filter: CreatedFilter) =>
        passes(item(1, { createdAt }), { ...defaultFilters(), created: filter }, NOW, new Set())
      expect(daysSince(createdAt, NOW)).toBeNull()
      expect(created('today')).toBe(false)
      expect(created('week')).toBe(false)
      expect(created('old')).toBe(false)
      expect(created('any')).toBe(true)
    }
  })

  it('drops a page filter the new space does not have and keeps the rest', () => {
    const others = [item(7, { projectId: 2, pageId: 9, pageTitle: 'Login' }), item(8, { projectId: 2 })]
    const picked = { ...defaultFilters(), page: '5', kind: 'finding' as const }
    const next = filtersForSpace(picked, others)
    expect(next).toEqual({ ...picked, page: 'all' })
    expect(activeFilters(next)).toBe(1)
    expect(filtersForSpace({ ...picked, page: '9' }, others)).toEqual({ ...picked, page: '9' })
    expect(filtersForSpace({ ...picked, page: 'none' }, others).page).toBe('none')
    expect(filtersForSpace({ ...picked, page: 'none' }, [others[0] as BacklogItem]).page).toBe('all')
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
