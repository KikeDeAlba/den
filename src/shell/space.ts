const SPACE_KEY = 'den.space'
const LEGACY_KEY = 'bita.notes.space'
const SPACE_EVENT = 'den:space'

function read(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

let current: string | null = null

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
