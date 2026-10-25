import { copyText, describeProblem, doctorReport, toolsStatus, type Check, type InstallCard } from '../../bita.ts'
import { element } from '../../dom.ts'
import { block, problemBox, quietButton, waiting } from './parts.ts'

const MARKS: Record<Check['health'], string> = { ok: '✓', warn: '·', fail: '✕' }

function checkRow(check: Check): HTMLElement {
  const line = element('div', `ajustes-check ajustes-check--${check.health}`)
  line.append(element('span', 'ajustes-check-mark', MARKS[check.health]))
  const text = element('div', 'ajustes-check-body')
  text.append(element('p', 'ajustes-check-title', check.title))
  for (const detail of check.detail.split('\n')) {
    if (detail.trim() !== '') text.append(element('p', 'ajustes-check-detail', detail))
  }
  if (check.note !== null) text.append(element('p', 'ajustes-check-note', check.note))
  line.append(text)
  return line
}

function installRow(card: InstallCard): HTMLElement {
  const line = element('div', 'ajustes-install')
  const text = element('div', 'ajustes-install-body')
  text.append(element('p', 'ajustes-check-title', card.title))
  if (card.purpose !== '') text.append(element('p', 'ajustes-check-detail', card.purpose))
  text.append(element('code', 'ajustes-command', card.command))
  const copy = quietButton('Copiar', () => {
    void copyText(card.command)
      .then(() => {
        copy.textContent = 'Copiado'
      })
      .catch((error: unknown) => {
        copy.textContent = describeProblem(error).message
      })
  })
  line.append(text, copy)
  return line
}

export function toolsBlock(): { element: HTMLElement; load(): Promise<void> } {
  let ticket = 0
  const again = quietButton('Volver a buscar', () => {
    again.disabled = true
    again.textContent = 'Buscando…'
    void toolsStatus(true)
      .catch(() => null)
      .finally(() => {
        again.disabled = false
        again.textContent = 'Volver a buscar'
        void load()
      })
  })
  const { section, body } = block('Herramientas', again)

  async function load(): Promise<void> {
    ticket += 1
    const mine = ticket
    if (body.childElementCount === 0) body.append(waiting())
    try {
      const report = await doctorReport()
      if (mine !== ticket) return
      body.replaceChildren()
      if (report.blocked) {
        body.append(
          element(
            'p',
            'ajustes-lede',
            'No encuentro ninguna herramienta. Den conecta bita, inkwell, tally, atl y recap cuando están instalados.',
          ),
        )
      }
      for (const check of report.checks) body.append(checkRow(check))
      for (const card of report.install) body.append(installRow(card))
    } catch (error) {
      if (mine === ticket) body.replaceChildren(problemBox(error))
    }
  }

  return { element: section, load }
}
