import { describeProblem } from '../bita.ts'
import { element } from '../dom.ts'
import type { SectionModule } from './section.ts'

export interface PlaceholderAction {
  label: string
  run: () => Promise<void>
}

export interface Placeholder {
  title: string
  note: string
  action?: PlaceholderAction
}

function render(host: HTMLElement, content: Placeholder): void {
  const box = element('div', 'section-placeholder')
  box.append(element('p', 'section-placeholder-title', content.title))
  box.append(element('p', 'section-placeholder-note', content.note))
  const action = content.action
  if (action !== undefined) {
    const button = element('button', 'ghost-button', action.label) as HTMLButtonElement
    button.type = 'button'
    const problem = element('p', 'section-placeholder-note')
    button.addEventListener('click', () => {
      problem.textContent = ''
      void action.run().catch((error: unknown) => {
        problem.textContent = describeProblem(error).message
      })
    })
    box.append(button, problem)
  }
  host.replaceChildren(box)
}

export function placeholderSection(content: Placeholder): SectionModule {
  return {
    mount(host) {
      render(host, content)
    },
    update() {},
    unmount() {},
  }
}
