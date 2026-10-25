import { element } from '../dom.ts'
import { modKey } from '../platform.ts'
import { sectionIcon } from './icons.ts'
import { go, SECTIONS, type SectionId } from './routes.ts'

export interface Rail {
  element: HTMLElement
  select(section: SectionId): void
}

function railButton(id: SectionId, label: string, key: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'rail-item'
  button.dataset['section'] = id
  button.title = `${label} (${modKey(key)})`
  button.setAttribute('aria-label', label)
  button.append(sectionIcon(id))
  button.addEventListener('click', () => go(id))
  return button
}

export function buildRail(): Rail {
  const nav = element('nav', 'rail')
  nav.setAttribute('aria-label', 'Secciones')
  const top = element('div', 'rail-group')
  const bottom = element('div', 'rail-group rail-group--end')
  const buttons = new Map<SectionId, HTMLButtonElement>()
  for (const section of SECTIONS) {
    const button = railButton(section.id, section.label, section.key)
    buttons.set(section.id, button)
    const group = section.id === 'ajustes' ? bottom : top
    group.append(button)
  }
  nav.append(top, bottom)
  return {
    element: nav,
    select(section) {
      for (const [id, button] of buttons) {
        if (id === section) button.setAttribute('aria-current', 'page')
        else button.removeAttribute('aria-current')
      }
    },
  }
}
