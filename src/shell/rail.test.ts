import { afterEach, describe, expect, it } from 'vitest'
import { modKey } from '../platform.ts'
import { buildRail } from './rail.ts'
import { SECTIONS } from './routes.ts'

function buttons(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>('button.rail-item')]
}

describe('rail', () => {
  afterEach(() => {
    location.hash = ''
  })

  it('renders one labelled button per section inside a named nav', () => {
    const { element } = buildRail()
    expect(element.tagName).toBe('NAV')
    expect(element.getAttribute('aria-label')).toBe('Secciones')
    const items = buttons(element)
    expect(items.map((item) => item.dataset['section'])).toEqual(SECTIONS.map((section) => section.id))
    for (const [index, item] of items.entries()) {
      const section = SECTIONS[index]!
      expect(item.getAttribute('aria-label')).toBe(section.label)
      expect(item.title).toBe(`${section.label} (${modKey(section.key)})`)
      expect(item.querySelector('svg')).not.toBeNull()
    }
  })

  it('puts settings alone in the end group', () => {
    const { element } = buildRail()
    const end = element.querySelector('.rail-group--end')
    expect(end).not.toBeNull()
    expect([...end!.querySelectorAll('button')].map((item) => item.dataset['section'])).toEqual(['ajustes'])
  })

  it('marks exactly one section as the current page', () => {
    const rail = buildRail()
    rail.select('docs')
    rail.select('cerebro')
    const current = buttons(rail.element).filter((item) => item.getAttribute('aria-current') === 'page')
    expect(current.map((item) => item.dataset['section'])).toEqual(['cerebro'])
  })

  it('navigates through the hash on click', () => {
    const { element } = buildRail()
    buttons(element)
      .find((item) => item.dataset['section'] === 'reuniones')!
      .click()
    expect(location.hash).toBe('#/reuniones')
  })
})
