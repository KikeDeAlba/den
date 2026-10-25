export const SECTIONS = [
  { id: 'ahora', label: 'Ahora', key: '1' },
  { id: 'agentes', label: 'Agentes', key: '2' },
  { id: 'tiempo', label: 'Tiempo', key: '3' },
  { id: 'docs', label: 'Documentación', key: '4' },
  { id: 'pendientes', label: 'Pendientes y hallazgos', key: '5' },
  { id: 'reuniones', label: 'Reuniones', key: '6' },
  { id: 'cerebro', label: 'Cerebro', key: '7' },
  { id: 'ajustes', label: 'Ajustes', key: ',' },
] as const

export type SectionId = (typeof SECTIONS)[number]['id']

export interface Route {
  section: SectionId
  path: string[]
}

export const DEFAULT_SECTION: SectionId = 'ahora'

export interface KeyPress {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

export function isSection(value: string): value is SectionId {
  return SECTIONS.some((section) => section.id === value)
}

export function sectionLabel(id: SectionId): string {
  return SECTIONS.find((section) => section.id === id)?.label ?? id
}

function decode(part: string): string {
  try {
    return decodeURIComponent(part)
  } catch {
    return part
  }
}

export function parseRoute(text: string): Route | null {
  const parts = text
    .trim()
    .replace(/^#/, '')
    .split('/')
    .filter((part) => part !== '')
    .map(decode)
  const [head, ...path] = parts
  if (head === undefined || !isSection(head)) return null
  return { section: head, path }
}

export function formatRoute(route: Route): string {
  return `#/${[route.section, ...route.path].map(encodeURIComponent).join('/')}`
}

export function shortcutSection(press: KeyPress, mac: boolean): SectionId | null {
  const modifier = mac ? press.metaKey && !press.ctrlKey : press.ctrlKey && !press.metaKey
  if (!modifier || press.altKey || press.shiftKey) return null
  return SECTIONS.find((section) => section.key === press.key)?.id ?? null
}

export function go(route: string): void {
  const parsed = parseRoute(route)
  if (parsed === null) return
  const next = formatRoute(parsed)
  if (location.hash !== next) location.hash = next
}
