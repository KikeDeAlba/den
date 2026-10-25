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
  positiveId,
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

describe('link edge cases', () => {
  it('rejects ids that are zero, signed, decimal, padded with text or beyond the safe range', () => {
    for (const bad of ['0', '-1', '1.5', '1e3', '12abc', ' 5', '', '9007199254740993']) {
      expect(positiveId(bad)).toBeNull()
    }
    expect(positiveId(undefined)).toBeNull()
    expect(positiveId('007')).toBe(7)
  })

  it('does not read an entry or meeting link with a bad id as a page', () => {
    expect(parseDocsPath(['_', 'entrada', 'x'])).toEqual({ kind: 'space', space: null })
    expect(parseDocsPath(['_', 'entrada'])).toEqual({ kind: 'space', space: null })
    expect(parseDocsPath(['_', 'reunion', '0'])).toEqual({ kind: 'space', space: null })
  })

  it('only treats entrada and reunion as special outside a space', () => {
    expect(parseDocsPath(['den', 'entrada', '3'])).toEqual({ kind: 'space', space: 'den' })
  })

  it('defaults a meeting link to the document tab', () => {
    expect(parseDocsPath(['_', 'reunion', '4'])).toEqual({ kind: 'meeting', entryId: 4, tab: 'document' })
  })

  it('escapes slashes, spaces and unicode in spaces, keys and meeting ids', () => {
    const route = pendientesRoute('mi espacio/ñ', 'A/B #1')
    expect(route.split('/')).toHaveLength(3)
    expect(parsePendientesPath(route.split('/').slice(1).map(decodeURIComponent))).toEqual({ space: 'mi espacio/ñ', key: 'A/B #1' })
    expect(parseRoute(route)?.path).toEqual(['mi espacio/ñ', 'A/B #1'])
    expect(parseRoute(meetingRoute('a/b', 'grabacion'))?.path).toEqual(['a/b', 'grabacion'])
  })

  it('keeps an underscore space distinct from "any space" only through its position', () => {
    expect(parsePendientesPath(['_'])).toEqual({ space: null, key: null })
    expect(parseDocsPath(['_', '12'])).toEqual({ kind: 'page', space: null, pageId: 12 })
  })

  it('ignores extra trailing segments', () => {
    expect(parseDocsPath(['den', '5', 'extra', 'more'])).toEqual({ kind: 'page', space: 'den', pageId: 5 })
    expect(parsePendientesPath(['den', 'K-1', 'extra'])).toEqual({ space: 'den', key: 'K-1' })
  })

  it('round-trips every docs target kind', () => {
    const targets = [
      { kind: 'space', space: null },
      { kind: 'space', space: 'den' },
      { kind: 'page', space: 'den', pageId: 3 },
      { kind: 'page', space: null, pageId: 3 },
      { kind: 'view', space: null, view: 'storage' },
      { kind: 'view', space: 'den', view: 'space-settings' },
      { kind: 'view', space: 'den', view: 'atlassian' },
      { kind: 'entry', entryId: 8 },
      { kind: 'meeting', entryId: 8, tab: 'transcript' },
    ] as const
    for (const target of targets) {
      expect(parseDocsPath(split(docsRoute(target)))).toEqual(target)
      expect(parseRoute(docsRoute(target))?.section).toBe('docs')
    }
  })

  it('routes entry links to their sections', () => {
    expect(parseRoute(entryMeetingRoute(5))).toMatchObject({ section: 'reuniones', path: ['entry', '5'] })
    expect(parseRoute(entrySessionRoute(5))).toMatchObject({ section: 'agentes', path: ['entry', '5'] })
    expect(parseRoute(pendientesRoute('den', 'DEN-2'))).toMatchObject({ section: 'pendientes', path: ['den', 'DEN-2'] })
    expect(parseRoute(entryNoteRoute(5))).toMatchObject({ section: 'docs', path: ['_', 'entrada', '5'] })
  })
})
