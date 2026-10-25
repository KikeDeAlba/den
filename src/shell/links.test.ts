import { describe, expect, it } from 'vitest'
import {
  docsMeetingRoute,
  docsRoute,
  entryMeetingRoute,
  entryNoteRoute,
  entrySessionRoute,
  meetingRoute,
  pageRoute,
  parseDocsPath,
  parsePendientesPath,
  pendientesRoute,
} from './links.ts'
import { parseRoute } from './routes.ts'

const split = (route: string): string[] => route.split('/').slice(1).map(decodeURIComponent)

describe('docs links', () => {
  it('keeps the current space on an empty path', () => {
    expect(parseDocsPath([])).toEqual({ kind: 'space', space: null })
  })

  it('round-trips a page with and without a space', () => {
    expect(pageRoute(42, 'viva-cash')).toBe('docs/viva-cash/42')
    expect(parseDocsPath(split(pageRoute(42, 'viva-cash')))).toEqual({ kind: 'page', space: 'viva-cash', pageId: 42 })
    expect(parseDocsPath(split(pageRoute(7)))).toEqual({ kind: 'page', space: null, pageId: 7 })
  })

  it('treats storage, settings and connections as views of the space', () => {
    for (const view of ['storage', 'space-settings', 'atlassian'] as const) {
      const route = docsRoute({ kind: 'view', space: 'den', view })
      expect(parseDocsPath(split(route))).toEqual({ kind: 'view', space: 'den', view })
    }
  })

  it('resolves entry notes and meetings outside any space', () => {
    expect(entryNoteRoute(12)).toBe('docs/_/entrada/12')
    expect(parseDocsPath(split(entryNoteRoute(12)))).toEqual({ kind: 'entry', entryId: 12 })
    expect(parseDocsPath(split(docsMeetingRoute(9, 'proposals')))).toEqual({ kind: 'meeting', entryId: 9, tab: 'proposals' })
  })

  it('falls back to the space when the page id is not a positive integer', () => {
    expect(parseDocsPath(['den', '0'])).toEqual({ kind: 'space', space: 'den' })
    expect(parseDocsPath(['den', 'abc'])).toEqual({ kind: 'space', space: 'den' })
  })
})

describe('backlog links', () => {
  it('builds and parses a backlog item in its space', () => {
    expect(pendientesRoute('viva-cash', 'STI-21')).toBe('pendientes/viva-cash/STI-21')
    expect(pendientesRoute(null)).toBe('pendientes')
    expect(pendientesRoute(null, '#4')).toBe('pendientes/_/%234')
    expect(parsePendientesPath(['_', '#4'])).toEqual({ space: null, key: '#4' })
    expect(parsePendientesPath(['den'])).toEqual({ space: 'den', key: null })
  })
})

describe('entry links', () => {
  it('links a timer to its meeting and its agent session', () => {
    expect(entryMeetingRoute(7)).toBe('reuniones/entry/7')
    expect(entrySessionRoute(7)).toBe('agentes/entry/7')
  })

  it('opens a meeting on its minutes unless another tab is asked', () => {
    expect(meetingRoute('2026-10-20 sync')).toBe('reuniones/2026-10-20%20sync')
    expect(meetingRoute('m1', 'grabacion')).toBe('reuniones/m1/grabacion')
  })

  it('produces routes the shell router understands', () => {
    for (const route of [pageRoute(3, 'den'), entryNoteRoute(5), pendientesRoute('den', 'DEN-2'), entryMeetingRoute(5), entrySessionRoute(5)]) {
      expect(parseRoute(route)).not.toBeNull()
    }
    expect(parseRoute(pendientesRoute(null, '#4'))?.path).toEqual(['_', '#4'])
  })
})
