import assert from 'node:assert/strict'
import { test } from 'vitest'
import { docsRoute, entryRoute, meetingRoute, pageRoute, parseDocsPath } from './route.ts'

const split = (route: string): string[] => route.split('/').slice(1).map(decodeURIComponent)

test('an empty path keeps the current space', () => {
  assert.deepEqual(parseDocsPath([]), { kind: 'space', space: null })
})

test('a page route round-trips with and without a space', () => {
  assert.deepEqual(parseDocsPath(split(pageRoute(42, 'viva-cash'))), { kind: 'page', space: 'viva-cash', pageId: 42 })
  assert.deepEqual(parseDocsPath(split(pageRoute(7))), { kind: 'page', space: null, pageId: 7 })
})

test('storage, settings and connections are views of the space', () => {
  for (const view of ['storage', 'space-settings', 'atlassian'] as const) {
    const route = docsRoute({ kind: 'view', space: 'den', view })
    assert.deepEqual(parseDocsPath(split(route)), { kind: 'view', space: 'den', view })
  }
})

test('entries and meetings resolve outside any space', () => {
  assert.deepEqual(parseDocsPath(split(entryRoute(12))), { kind: 'entry', entryId: 12 })
  assert.deepEqual(parseDocsPath(split(meetingRoute(9, 'proposals'))), { kind: 'meeting', entryId: 9, tab: 'proposals' })
})

test('a page id that is not a positive integer falls back to the space', () => {
  assert.deepEqual(parseDocsPath(['den', '0']), { kind: 'space', space: 'den' })
  assert.deepEqual(parseDocsPath(['den', 'abc']), { kind: 'space', space: 'den' })
})
