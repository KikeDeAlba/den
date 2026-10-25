import {
  describeProblem,
  liveShortcutSet,
  liveShow,
  liveSources,
  recapConfig,
  recapConfigSet,
  toolsStatus,
  installHint,
  type ToolsStatus,
  type LiveConfig,
  type LiveTimer,
  type LiveView,
  type PendingMeeting,
} from './bita.ts'
import { docsMeetingRoute } from './shell/links.ts'
import { go } from './shell/routes.ts'
import { element, icon } from './dom.ts'
import { acceleratorFrom, shortcutLabel } from './shortcut.ts'

export function liveMatches(timer: LiveTimer, live: LiveView | null): boolean {
  if (live === null || live.active === null) return false
  if (live.entryId !== null) return live.entryId === timer.id
  return timer.kind === 'meeting' || timer.kind === 'remote-meeting' || timer.kind === 'in-person-meeting'
}

function delayLabel(live: LiveView): string | null {
  const started = live.active?.startedAt
  const last = live.transcript.at(-1)
  if (started === null || started === undefined || last === undefined) return null
  const lag = Math.round((Date.now() - new Date(started).getTime() - last.endMs) / 1000)
  return Number.isFinite(lag) && lag >= 0 ? `~${lag} s de retraso` : null
}

export function assistantRow(live: LiveView): HTMLElement {
  const wrap = element('div', 'assist')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'assist-button'
  button.append(icon('question', 14), element('span', '', 'Asistente'))
  if (live.answers.length > 0) button.append(element('span', 'assist-count', String(live.answers.length)))
  button.addEventListener('click', () => {
    void liveShow()
  })
  wrap.append(button)
  const status = element('p', 'assist-status')
  status.append(icon('bars', 11))
  const delay = delayLabel(live)
  status.append(
    element(
      'span',
      '',
      live.transcript.length === 0 ? 'Esperando la transcripción en vivo' : `Transcribiendo en vivo${delay === null ? '' : ` · ${delay}`}`,
    ),
  )
  wrap.append(status)
  return wrap
}

function ago(iso: string | null): string | null {
  if (iso === null) return null
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(seconds) || seconds < 0) return null
  if (seconds < 60) return 'hace un momento'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `hace ${hours} h`
  const days = Math.round(hours / 24)
  return `hace ${days} ${days === 1 ? 'día' : 'días'}`
}

export function pendingCount(pending: PendingMeeting[]): number {
  return pending.reduce((total, meeting) => total + meeting.proposals.length, 0)
}

export function proposalsCard(meeting: PendingMeeting): HTMLElement {
  const card = element('article', 'proposals-card')
  const head = element('div', 'proposals-head')
  const count = meeting.proposals.length
  head.append(element('span', 'proposals-title', `${count} ${count === 1 ? 'cambio propuesto' : 'cambios propuestos'}`), element('span', 'spacer'))
  const when = ago(meeting.endedAt)
  if (when !== null) head.append(element('span', 'proposals-when', when))
  card.append(head)

  const lede = element('p', 'proposals-lede')
  lede.append('De ', element('b', '', meeting.title), '. Se dijeron en la reunión y tocan páginas que ya existen.')
  card.append(lede)

  const pages = new Map<string, number>()
  for (const proposal of meeting.proposals) {
    const name = proposal.pageTitle ?? `Página ${proposal.pageId}`
    pages.set(name, (pages.get(name) ?? 0) + 1)
  }
  const list = element('div', 'proposals-pages')
  for (const [name, sections] of pages) {
    const row = element('div', 'proposals-page')
    row.append(
      element('i', 'proposals-bullet'),
      element('span', 'proposals-page-name', name),
      element('span', 'proposals-page-count', `${sections} ${sections === 1 ? 'sección' : 'secciones'}`),
    )
    list.append(row)
  }
  card.append(list)

  const review = document.createElement('button')
  review.type = 'button'
  review.className = 'proposals-review'
  review.append(icon('check', 14), element('span', '', 'Revisar cambios'))
  review.addEventListener('click', () => {
    go(docsMeetingRoute(meeting.entryId, 'proposals'))
  })
  card.append(review)
  return card
}

function toggle(label: string, on: boolean, disabled: boolean, onChange: (next: boolean) => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'switch'
  button.setAttribute('role', 'switch')
  button.setAttribute('aria-checked', String(on))
  button.setAttribute('aria-label', label)
  button.disabled = disabled
  button.append(element('span', 'switch-knob'))
  button.addEventListener('click', () => onChange(!on))
  return button
}

const CONCURRENCY_MIN = 1
const CONCURRENCY_MAX = 6

function stepper(label: string, value: number, disabled: boolean, onChange: (next: number) => void): HTMLElement {
  const group = element('div', 'live-stepper')
  group.setAttribute('role', 'group')
  group.setAttribute('aria-label', label)
  const step = (name: 'minus' | 'plus', text: string, next: number): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'live-stepper-button'
    button.setAttribute('aria-label', text)
    button.disabled = disabled || next < CONCURRENCY_MIN || next > CONCURRENCY_MAX
    button.append(icon(name, 12))
    button.addEventListener('click', () => onChange(next))
    return button
  }
  const shown = element('output', 'live-stepper-value', String(value))
  shown.setAttribute('aria-live', 'polite')
  group.append(step('minus', 'Una menos', value - 1), shown, step('plus', 'Una más', value + 1))
  return group
}

function settingRow(title: string, note: string, control: HTMLElement, last = false): HTMLElement {
  const row = element('div', last ? 'live-setting live-setting--last' : 'live-setting')
  const words = element('div', 'live-setting-words')
  words.append(element('span', 'live-setting-title', title), element('span', 'live-setting-note', note))
  row.append(words, control)
  return row
}

interface SettingsState {
  config: LiveConfig | null
  loaded: boolean
  shortcut: string
  capturing: boolean
  failure: string | null
  repos: { slug: string; exists: boolean }[] | null
  tools: ToolsStatus | null
}

export function renderLiveSettings(
  host: HTMLElement,
  shortcut: string,
  project: string | null,
  onBack: () => void,
): void {
  const state: SettingsState = { config: null, loaded: false, shortcut, capturing: false, failure: null, repos: null, tools: null }

  const paint = (): void => {
    host.replaceChildren()
    const head = element('div', 'live-settings-head')
    const back = document.createElement('button')
    back.type = 'button'
    back.className = 'icon-button'
    back.setAttribute('aria-label', 'Volver')
    back.append(icon('prev', 14))
    back.addEventListener('click', onBack)
    head.append(back, element('span', 'live-settings-title', 'Asistente de reunión'))
    host.append(head)

    if (state.failure !== null) {
      const box = element('div', 'problem')
      box.append(element('p', 'problem-message', state.failure))
      host.append(box)
    }

    if (state.loaded && state.config === null) {
      const missing = state.tools !== null && !state.tools.modules.liveAssistant
      const box = element('div', 'problem')
      box.append(
        element(
          'p',
          'problem-message',
          missing ? 'Para el asistente de reunión hace falta instalar recap.' : 'recap no devolvió los ajustes del asistente.',
        ),
      )
      box.append(element('code', 'problem-hint', installHint(state.tools, 'recap')))
      host.append(box)
    }

    const config = state.config
    const off = config === null
    const autoAskOff = state.tools !== null && !state.tools.modules.autoAsk
    const group = element('div', 'live-settings-group')
    group.append(
      settingRow(
        'Transcribir en vivo',
        'whisper local, mientras recap graba',
        toggle('Transcribir en vivo', config?.enabled ?? false, off, (next) => change('live.enabled', next)),
      ),
      settingRow(
        'Abrir la ventana al grabar',
        'se cierra sola al parar la reunión',
        toggle('Abrir la ventana al grabar', config?.openWindow ?? false, off, (next) => change('live.openWindow', next)),
      ),
      settingRow(
        'Detectar preguntas automáticamente',
        autoAskOff
          ? 'tu versión de recap no ofrece la detección automática'
          : 'responde solo, sin el atajo, lo que se pueda contestar con las páginas o el código',
        toggle(
          'Detectar preguntas automáticamente',
          config?.autoAsk ?? false,
          off || autoAskOff,
          (next) => change('live.autoAsk', next),
        ),
      ),
    )
    const concurrency = config?.autoAskConcurrency ?? null
    if (config !== null && concurrency !== null) {
      const value = Math.min(CONCURRENCY_MAX, Math.max(CONCURRENCY_MIN, concurrency))
      group.append(
        settingRow(
          'Respuestas en paralelo',
          'cuántas preguntas detectadas se responden a la vez; las demás esperan en cola',
          stepper('Respuestas en paralelo', value, config.autoAsk !== true, (next) => change('live.autoAskConcurrency', next)),
        ),
      )
    }
    group.append(settingRow('Atajo para responder', 'funciona aunque Den no tenga el foco', shortcutButton(), true))
    host.append(group)

    const sources = element('div', 'live-settings-section')
    sources.append(element('span', 'live-settings-label', 'FUENTES'))
    const box = element('div', 'live-settings-group')
    const inner = element('div', 'live-setting live-setting--stack live-setting--last')
    inner.append(
      element(
        'span',
        'live-setting-note',
        project === null ? 'Las fuentes salen del proyecto de la reunión en curso.' : `Repos del proyecto ${project} encontrados en disco`,
      ),
    )
    const chips = element('div', 'live-repos')
    if (state.repos === null) {
      if (project !== null) chips.append(element('span', 'live-setting-note', 'Buscando…'))
    } else if (state.repos.length === 0) {
      chips.append(element('span', 'live-setting-note', 'Todavía no hay repos ligados a este proyecto.'))
    } else {
      for (const repo of state.repos) {
        chips.append(element('span', repo.exists ? 'live-repo' : 'live-repo live-repo--missing', repo.exists ? repo.slug : `${repo.slug} · no clonado`))
      }
    }
    inner.append(chips)
    box.append(inner)
    sources.append(box)
    host.append(sources)

    const closing = element('div', 'live-settings-section')
    closing.append(element('span', 'live-settings-label', 'AL CERRAR LA REUNIÓN'))
    const closingBox = element('div', 'live-settings-group')
    closingBox.append(
      settingRow(
        'Proponer cambios a páginas',
        'nada se escribe sin que lo apruebes',
        toggle('Proponer cambios a páginas', config?.proposals ?? false, off, (next) => change('live.proposals', next)),
        true,
      ),
    )
    closing.append(closingBox)
    host.append(closing)
  }

  const shortcutButton = (): HTMLButtonElement => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = state.capturing ? 'live-shortcut-button live-shortcut-button--capturing' : 'live-shortcut-button'
    button.textContent = state.capturing ? 'Pulsa el atajo…' : shortcutLabel(state.shortcut)
    button.addEventListener('click', () => {
      state.capturing = !state.capturing
      paint()
      if (state.capturing) host.querySelector<HTMLButtonElement>('.live-shortcut-button')?.focus()
    })
    button.addEventListener('keydown', (event) => {
      if (!state.capturing) return
      event.preventDefault()
      if (event.key === 'Escape') {
        state.capturing = false
        paint()
        return
      }
      const accelerator = acceleratorFrom(event)
      if (accelerator === null) return
      state.capturing = false
      void liveShortcutSet(accelerator)
        .then((saved) => {
          state.shortcut = saved
          state.failure = null
        })
        .catch((error: unknown) => {
          state.failure = describeProblem(error).message
        })
        .finally(paint)
    })
    return button
  }

  const change = (key: string, value: boolean | number): void => {
    void recapConfigSet(key, value)
      .then((next) => {
        if (next !== null) state.config = next
        state.failure = null
      })
      .catch((error: unknown) => {
        state.failure = describeProblem(error).message
      })
      .finally(paint)
  }

  paint()
  void toolsStatus()
    .then((status) => {
      state.tools = status
    })
    .catch(() => {
      state.tools = null
    })
    .finally(paint)
  void recapConfig()
    .then((config) => {
      state.config = config
    })
    .catch((error: unknown) => {
      state.failure = describeProblem(error).message
    })
    .finally(() => {
      state.loaded = true
      paint()
    })
  if (project !== null) {
    void liveSources(project)
      .then((sources) => {
        state.repos = sources === null ? [] : sources.repos.map((repo) => ({ slug: repo.slug, exists: repo.exists }))
      })
      .catch(() => {
        state.repos = []
      })
      .finally(paint)
  }
}
