import { isSection, type SectionId } from './routes.ts'

const SECTION_KEY = 'den.section'

export function rememberedSection(): SectionId | null {
  try {
    const value = localStorage.getItem(SECTION_KEY)
    return value !== null && isSection(value) ? value : null
  } catch {
    return null
  }
}

export function rememberSection(section: SectionId): void {
  try {
    localStorage.setItem(SECTION_KEY, section)
  } catch {
    return
  }
}
