import { notesTree, type Space } from '../bita.ts'

const SPACE_KEY = 'den.space'
const LEGACY_SPACE_KEY = 'bita.notes.space'

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
  return read(SPACE_KEY) ?? read(LEGACY_SPACE_KEY)
}

export function rememberSpace(slug: string): void {
  try {
    localStorage.setItem(SPACE_KEY, slug)
  } catch {
    return
  }
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
