import { liveState } from '../../bita.ts'
import { element } from '../../dom.ts'
import { isMac, modKey } from '../../platform.ts'
import { SECTIONS } from '../../shell/routes.ts'
import { shortcutLabel } from '../../shortcut.ts'
import { block, quietButton, row } from './parts.ts'

const DEFAULT_SHORTCUT = 'Ctrl+Alt+Space'

function tag(text: string): HTMLElement {
  return element('span', 'tag', text)
}

function sectionRange(): string {
  const numbered = SECTIONS.map((section) => section.key).filter((key) => /^\d$/.test(key))
  const first = numbered[0] ?? '1'
  const last = numbered[numbered.length - 1] ?? first
  return isMac ? `${modKey(first)} – ${modKey(last)}` : `${modKey(first)} – ${last}`
}

export function shortcutsBlock(
  assistant: () => boolean,
  openAssistant: () => void,
): { element: HTMLElement; load(): Promise<void> } {
  const { section, body } = block('Atajos')

  function paint(shortcut: string): void {
    body.replaceChildren()
    if (assistant()) {
      body.append(
        row(
          element('span', 'ajustes-row-label', 'Asistente de reunión'),
          tag(shortcutLabel(shortcut)),
          quietButton('Cambiar', openAssistant),
        ),
      )
    }
    body.append(row(element('span', 'ajustes-row-label', 'Ir a una sección'), tag(sectionRange())))
    body.append(row(element('span', 'ajustes-row-label', 'Ajustes'), tag(modKey(','))))
  }

  async function load(): Promise<void> {
    if (!assistant()) {
      paint(DEFAULT_SHORTCUT)
      return
    }
    try {
      paint((await liveState()).shortcut)
    } catch {
      paint(DEFAULT_SHORTCUT)
    }
  }

  paint(DEFAULT_SHORTCUT)
  return { element: section, load }
}
