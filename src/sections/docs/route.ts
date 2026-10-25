export const ANY_SPACE = '_'

const STORAGE = 'almacenamiento'
const SETTINGS = 'ajustes'
const CONNECTIONS = 'conexiones'
const ENTRY = 'entrada'
const MEETING = 'reunion'

export type DocsView = 'storage' | 'space-settings' | 'atlassian'

export type DocsTarget =
  | { kind: 'space'; space: string | null }
  | { kind: 'page'; space: string | null; pageId: number }
  | { kind: 'view'; space: string | null; view: DocsView }
  | { kind: 'entry'; entryId: number }
  | { kind: 'meeting'; entryId: number; tab: string }

function id(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function spaceOf(text: string | undefined): string | null {
  return text === undefined || text === ANY_SPACE ? null : text
}

export function parseDocsPath(path: readonly string[]): DocsTarget {
  const [head, second, third, fourth] = path
  const space = spaceOf(head)
  if (head === ANY_SPACE && second === ENTRY) {
    const entryId = id(third)
    if (entryId !== null) return { kind: 'entry', entryId }
  }
  if (head === ANY_SPACE && second === MEETING) {
    const entryId = id(third)
    if (entryId !== null) return { kind: 'meeting', entryId, tab: fourth ?? 'document' }
  }
  if (second === STORAGE) return { kind: 'view', space, view: 'storage' }
  if (second === SETTINGS) return { kind: 'view', space, view: third === CONNECTIONS ? 'atlassian' : 'space-settings' }
  const pageId = id(second)
  if (pageId !== null) return { kind: 'page', space, pageId }
  return { kind: 'space', space }
}

export function docsRoute(target: DocsTarget): string {
  const parts = ['docs']
  switch (target.kind) {
    case 'space':
      if (target.space !== null) parts.push(target.space)
      break
    case 'page':
      parts.push(target.space ?? ANY_SPACE, String(target.pageId))
      break
    case 'view':
      parts.push(target.space ?? ANY_SPACE)
      if (target.view === 'storage') parts.push(STORAGE)
      else parts.push(SETTINGS, ...(target.view === 'atlassian' ? [CONNECTIONS] : []))
      break
    case 'entry':
      parts.push(ANY_SPACE, ENTRY, String(target.entryId))
      break
    case 'meeting':
      parts.push(ANY_SPACE, MEETING, String(target.entryId), target.tab)
      break
  }
  return parts.map(encodeURIComponent).join('/')
}

export function pageRoute(pageId: number, space: string | null = null): string {
  return docsRoute({ kind: 'page', space, pageId })
}

export function entryRoute(entryId: number): string {
  return docsRoute({ kind: 'entry', entryId })
}

export function meetingRoute(entryId: number, tab: string): string {
  return docsRoute({ kind: 'meeting', entryId, tab })
}
