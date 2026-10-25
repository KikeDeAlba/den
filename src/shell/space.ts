import { notesTree, type Space } from '../bita.ts'

const SPACE_KEY = 'den.space'
const LEGACY_KEY = 'bita.notes.space'
const SPACE_EVENT = 'den:space'

let current: string | null = null
let spaces: Promise<Space[]> | null = null

function read(key: string): string | null {
  try {
    const value = localStorage.getItem(key)
    return value === null || value === '' ? null : value
  } catch {
    return null
  }
}

export function rememberedSpace(): string | null {
  return read(SPACE_KEY) ?? current ?? read(LEGACY_KEY)
}

export function rememberSpace(slug: string): void {
  if (slug === rememberedSpace()) return
  try {
    localStorage.setItem(SPACE_KEY, slug)
  } catch {
    current = slug
  }
  window.dispatchEvent(new CustomEvent<string>(SPACE_EVENT, { detail: slug }))
}

export function onSpaceChange(handler: (slug: string) => void): () => void {
  const listener = (event: Event): void => {
    const slug = (event as CustomEvent<string>).detail
    if (typeof slug === 'string') handler(slug)
  }
  window.addEventListener(SPACE_EVENT, listener)
  return () => window.removeEventListener(SPACE_EVENT, listener)
}

export function isSpaceShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k'
}

export function loadSpaces(fresh = false): Promise<Space[]> {
  if (fresh || spaces === null) {
    const pending = notesTree().then((payload) => payload.data.spaces ?? [])
    pending.catch(() => {
      if (spaces === pending) spaces = null
    })
    spaces = pending
  }
  return spaces
}

export function chooseSpace(list: readonly Space[], wanted: string | null): Space | null {
  return (
    list.find((space) => space.projectSlug === wanted) ??
    list.find((space) => space.pageCount > 0) ??
    list[0] ??
    null
  )
}

type SpaceRef = Pick<Space, 'projectId' | 'projectKey' | 'projectName' | 'projectSlug'>

function filled(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? ''
  return trimmed.length > 0 ? trimmed : null
}

export function inkwellProject(space: SpaceRef): string {
  return (
    filled(space.projectKey) ??
    (space.projectId === null ? null : String(space.projectId)) ??
    filled(space.projectName) ??
    space.projectSlug
  )
}

export function inkwellProjectOf(list: readonly SpaceRef[], slug: string | null): string | null {
  if (slug === null) return null
  const space = list.find((candidate) => candidate.projectSlug === slug)
  return space === undefined ? slug : inkwellProject(space)
}

export function sameProject(space: SpaceRef, project: string): boolean {
  const wanted = project.trim().toLowerCase()
  return [space.projectKey, space.projectName, space.projectSlug, space.projectId === null ? null : String(space.projectId)].some(
    (value) => filled(value)?.toLowerCase() === wanted,
  )
}
