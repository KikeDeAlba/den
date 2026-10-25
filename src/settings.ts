import { copyText, describeProblem, quit, toolsStatus, type Check, type InstallCard, type Report } from './bita.ts'
import { element, icon } from './dom.ts'

const MARKS: Record<Check['health'], string> = {
  ok: '✓',
  warn: '·',
  fail: '✕',
}

function checkRow(check: Check): HTMLElement {
  const row = element('div', `check check--${check.health}`)

  const mark = element('span', 'check-mark', MARKS[check.health])
  const body = element('div', 'check-body')
  body.append(element('p', 'check-title', check.title))
  for (const line of check.detail.split('\n')) {
    body.append(element('p', 'check-detail', line))
  }
  if (check.note !== null) body.append(element('p', 'check-note', check.note))

  row.append(mark, body)
  return row
}

function installCard(card: InstallCard): HTMLElement {
  const box = element('div', 'install-card')
  box.append(element('p', 'install-card-title', card.title))
  if (card.purpose !== '') box.append(element('p', 'install-card-note', card.purpose))
  const row = element('div', 'install-card-row')
  row.append(element('code', 'install-card-command', card.command))
  const copy = element('button', 'ghost-button', 'Copiar') as HTMLButtonElement
  copy.type = 'button'
  copy.addEventListener('click', () => {
    void copyText(card.command)
      .then(() => {
        copy.textContent = 'Copiado'
      })
      .catch((error: unknown) => {
        copy.textContent = describeProblem(error).message
      })
  })
  row.append(copy)
  box.append(row)
  return box
}

export function renderSettings(
  view: HTMLElement,
  report: Report,
  onDone: () => void,
  onReload: () => void,
  onLive: () => void,
): void {
  view.replaceChildren()

  const head = element('div', 'settings-head')
  head.append(
    element(
      'p',
      'settings-title',
      report.blocked ? 'No encuentro ninguna herramienta' : 'Todo listo',
    ),
  )
  head.append(
    element(
      'p',
      'settings-note',
      report.blocked
        ? 'Den conecta bita, inkwell, tally, atl y recap cuando están instalados. Instala la que necesites y vuelve aquí.'
        : 'Den conecta las herramientas que encuentra en el registro. Esto es lo que está usando.',
    ),
  )
  view.append(head)

  const checks = element('div', 'checks')
  for (const check of report.checks) checks.append(checkRow(check))
  view.append(checks)

  if (report.install.length > 0) {
    const cards = element('div', 'install-cards')
    for (const card of report.install) cards.append(installCard(card))
    view.append(cards)
  }

  const recheck = element('button', 'ghost-button wide', 'Volver a buscar') as HTMLButtonElement
  recheck.type = 'button'
  recheck.addEventListener('click', () => {
    recheck.disabled = true
    recheck.textContent = 'Buscando…'
    void toolsStatus(true).finally(onReload)
  })
  view.append(recheck)

  const live = document.createElement('button')
  live.type = 'button'
  live.className = 'settings-link'
  live.append(
    icon('question', 14),
    element('span', 'settings-link-title', 'Asistente de reunión'),
    element('span', 'settings-link-note', 'en vivo y al cerrar'),
    icon('chevronRight', 13),
  )
  live.addEventListener('click', onLive)
  if (report.tools.modules.liveAssistant) view.append(live)

  const close = element('button', 'ghost-button wide', 'Volver') as HTMLButtonElement
  close.type = 'button'
  close.addEventListener('click', onDone)
  view.append(close)

  const leave = element('div', 'leave')
  leave.append(
    element('p', 'leave-note', 'Cerrar la ventana no detiene Den: el reloj sigue en la barra de menús.'),
  )
  const stop = element('button', 'danger-button wide', 'Salir de Den') as HTMLButtonElement
  stop.type = 'button'
  stop.addEventListener('click', () => {
    void quit()
  })
  leave.append(stop)
  view.append(leave)
}
