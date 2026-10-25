export const ANY_SPACE = '_'

const STORAGE = 'almacenamiento'
const SETTINGS = 'ajustes'
const CONNECTIONS = 'conexiones'
const DOCS_ENTRY = 'entrada'
const MEETING = 'reunion'

export type DocsView = 'storage' | 'space-settings' | 'atlassian'

export type DocsTarget =
  | { kind: 'space'; space: string | null }
  | { kind: 'page'; space: string | null; pageId: number }
  | { kind: 'view'; space: string | null; view: DocsView }
  | { kind: 'entry'; entryId: number }
  | { kind: 'meeting'; entryId: number; tab: string }

export function positiveId(text: string | undefined): number | null {
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
  if (head === ANY_SPACE && second === DOCS_ENTRY) {
    const entryId = positiveId(third)
    if (entryId !== null) return { kind: 'entry', entryId }
  }
  if (head === ANY_SPACE && second === MEETING) {
    const entryId = positiveId(third)
    if (entryId !== null) return { kind: 'meeting', entryId, tab: fourth ?? 'document' }
  }
  if (second === STORAGE) return { kind: 'view', space, view: 'storage' }
  if (second === SETTINGS) return { kind: 'view', space, view: third === CONNECTIONS ? 'atlassian' : 'space-settings' }
  const pageId = positiveId(second)
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
      parts.push(ANY_SPACE, DOCS_ENTRY, String(target.entryId))
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

export function entryNoteRoute(entryId: number): string {
  return docsRoute({ kind: 'entry', entryId })
}

export function docsMeetingRoute(entryId: number, tab: string): string {
  return docsRoute({ kind: 'meeting', entryId, tab })
}

export interface PendientesTarget {
  space: string | null
  key: string | null
}

export function parsePendientesPath(path: readonly string[]): PendientesTarget {
  const [space, key] = path
  return { space: space === undefined || space === ANY_SPACE ? null : space, key: key ?? null }
}

export function pendientesRoute(space: string | null, key: string | null = null): string {
  const parts = ['pendientes']
  if (space !== null || key !== null) parts.push(space ?? ANY_SPACE)
  if (key !== null) parts.push(key)
  return parts.map(encodeURIComponent).join('/')
}

export const ENTRY = 'entry'
export const MINUTES_TAB = 'minuta'

export function entryMeetingRoute(entryId: number): string {
  return ['reuniones', ENTRY, String(entryId)].join('/')
}

export function entrySessionRoute(entryId: number): string {
  return ['agentes', ENTRY, String(entryId)].join('/')
}

export function meetingRoute(id: string, tab: string = MINUTES_TAB): string {
  const parts = ['reuniones', id]
  if (tab !== MINUTES_TAB) parts.push(tab)
  return parts.map(encodeURIComponent).join('/')
}
