import { menubarSettings, menubarSettingsSet, type MenubarSettings } from '../../bita.ts'
import { element } from '../../dom.ts'
import { block, problemBox, row, toggle } from './parts.ts'

const OPTIONS: { key: keyof MenubarSettings; label: string }[] = [
  { key: 'showLabel', label: 'Mostrar el título junto al reloj' },
  { key: 'hideWhenIdle', label: 'Ocultar el ícono si no corre nada' },
]

export function menubarBlock(): { element: HTMLElement; load(): Promise<void> } {
  const { section, body } = block('Barra de menús')
  let settings: MenubarSettings = { showLabel: true, hideWhenIdle: false }
  const failure = element('div', 'ajustes-failure')

  function paint(): void {
    body.replaceChildren(failure)
    for (const option of OPTIONS) {
      body.append(
        row(
          element('span', 'ajustes-row-label', option.label),
          toggle(option.label, settings[option.key], (next) => void change({ ...settings, [option.key]: next })),
        ),
      )
    }
  }

  async function change(next: MenubarSettings): Promise<void> {
    failure.replaceChildren()
    try {
      settings = await menubarSettingsSet(next)
    } catch (error) {
      failure.replaceChildren(problemBox(error))
    }
    paint()
  }

  async function load(): Promise<void> {
    try {
      settings = await menubarSettings()
    } catch {
      settings = { showLabel: true, hideWhenIdle: false }
    }
    paint()
  }

  paint()
  return { element: section, load }
}
