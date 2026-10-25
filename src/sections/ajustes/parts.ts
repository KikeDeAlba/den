import { describeProblem } from '../../bita.ts'
import { element } from '../../dom.ts'

export function block(title: string, action?: HTMLElement): { section: HTMLElement; body: HTMLElement } {
  const section = element('section', 'ajustes-block')
  const head = element('div', 'ajustes-block-head')
  head.append(element('h2', 'ajustes-label', title))
  if (action !== undefined) head.append(action)
  const body = element('div', 'ajustes-block-body')
  section.append(head, body)
  return { section, body }
}

export function quietButton(text: string, run: () => void): HTMLButtonElement {
  const button = element('button', 'quiet-link', text) as HTMLButtonElement
  button.type = 'button'
  button.addEventListener('click', run)
  return button
}

export function row(...children: (HTMLElement | string)[]): HTMLElement {
  const line = element('div', 'ajustes-row')
  line.append(...children)
  return line
}

export function problemBox(error: unknown): HTMLElement {
  const found = describeProblem(error)
  const box = element('div', 'problem')
  box.append(element('p', 'problem-message', found.message))
  if (found.hint !== null) box.append(element('code', 'problem-hint', found.hint))
  return box
}

export function waiting(): HTMLElement {
  return element('p', 'ajustes-wait', 'Preguntando al CLI…')
}

export function toggle(label: string, checked: boolean, change: (next: boolean) => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'switch'
  button.setAttribute('role', 'switch')
  button.setAttribute('aria-label', label)
  button.setAttribute('aria-checked', String(checked))
  button.append(element('span', 'switch-knob'))
  button.addEventListener('click', () => change(button.getAttribute('aria-checked') !== 'true'))
  return button
}
