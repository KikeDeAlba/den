import assert from 'node:assert/strict'
import { test } from 'vitest'
import type { BacklogItem } from '../../bita.ts'
import { ageLabel, closePrompt, findKey, groupIssues, inSpace, matches, stateOf } from './model.ts'
import { parsePendientesPath, pendientesRoute } from './route.ts'

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

test('open findings, open pendings and resolved items fall in their own column', () => {
  const groups = groupIssues([
    item(1, { kind: 'finding' }),
    item(2),
    item(3, { kind: 'finding', status: 'resolved', resolvedAt: '2026-10-21T10:00:00Z' }),
  ])
  assert.deepEqual(
    groups.map((group) => [group.label, group.items.map((found) => found.id)]),
    [
      ['Hallazgos', [1]],
      ['Pendientes', [2]],
      ['Resueltos', [3]],
    ],
  )
  assert.equal(stateOf({ kind: 'finding', status: 'resolved' }), 'resolved')
})

test('newest items come first inside a column', () => {
  const [, pending] = groupIssues([item(1, { createdAt: '2026-10-01T00:00:00Z' }), item(2, { createdAt: '2026-10-05T00:00:00Z' })])
  assert.deepEqual(pending?.items.map((found) => found.id), [2, 1])
})

test('a key jumps to its item ignoring case and the hash', () => {
  const list = [item(1, { key: 'STI-21' }), item(2)]
  assert.equal(findKey(list, 'sti-21')?.id, 1)
  assert.equal(findKey(list, '#2')?.id, 2)
  assert.equal(findKey(list, ''), undefined)
})

test('the space filter compares the project of each item', () => {
  assert.equal(inSpace(item(1), 1), true)
  assert.equal(inSpace(item(1, { projectId: null }), null), true)
  assert.equal(inSpace(item(1), 2), false)
})

test('search looks at the key, the title, the body and the page', () => {
  const found = item(1, { key: 'DEN-4', pageTitle: 'Ventana única', body: 'Terminal embebida' })
  assert.equal(matches(found, 'den-4'), true)
  assert.equal(matches(found, 'ventana'), true)
  assert.equal(matches(found, 'embebida'), true)
  assert.equal(matches(found, 'nada'), false)
})

test('ages read in minutes, hours, days and weeks', () => {
  const now = new Date('2026-10-25T12:00:00Z')
  assert.equal(ageLabel('2026-10-25T11:30:00Z', now), '30 min')
  assert.equal(ageLabel('2026-10-25T10:00:00Z', now), '2 h')
  assert.equal(ageLabel('2026-10-22T12:00:00Z', now), '3 d')
  assert.equal(ageLabel('2026-10-04T12:00:00Z', now), '3 sem')
  assert.equal(ageLabel(null, now), '')
})

test('the prompt for Claude names the key', () => {
  assert.equal(closePrompt({ id: 4, key: 'DEN-4' }), 'cierra DEN-4')
  assert.equal(closePrompt({ id: 4 }), 'cierra #4')
})

test('the route keeps the space and the key', () => {
  assert.equal(pendientesRoute('viva-cash', 'STI-21'), 'pendientes/viva-cash/STI-21')
  assert.equal(pendientesRoute(null), 'pendientes')
  assert.deepEqual(parsePendientesPath(['_', '%23']), { space: null, key: '%23' })
  assert.deepEqual(parsePendientesPath(['den']), { space: 'den', key: null })
})
