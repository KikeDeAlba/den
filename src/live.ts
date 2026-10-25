import { liveHide, liveModeSet, liveSources, type AnswerSource, type LiveAnswer, type PendingAsk } from './bita.ts'
import { element, icon, must } from './dom.ts'
import {
  askedClock,
  autoBadge,
  backlogButton,
  delayLabel,
  elapsedLabel,
  manualBadge,
  markdown,
  pendingLabel,
  pendingMark,
  sourceChip,
  transcriptLine,
  type SourceActions,
} from './live/render.ts'
import { Session } from './live/session.ts'
import { shortcutLabel } from './shortcut.ts'

const COPIED_MS = 1400

const root = must<HTMLElement>('#live')

let repoCount: number | null = null
let sourcesFor: string | null = null
let draft = ''
let notice: string | null = null
let noticeTimer = 0

const session = new Session({
  paint,
  flash,
  followLanded: true,
  reloaded: () => {
    void loadSources()
  },
})
const actions: SourceActions = { copy: (text) => session.copy(text), fail: flash }
const copy = (text: string): void => session.copy(text)

function flash(message: string): void {
  notice = message
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice = null
    paint()
  }, COPIED_MS)
  paint()
}

function header(): HTMLElement {
  const view = session.view
  const bar = element('header', 'live-bar')
  bar.setAttribute('data-tauri-drag-region', '')
  const dot = element('span', view.active === null ? 'live-dot live-dot--idle' : 'live-dot')
  const title = element('span', 'live-title', view.title ?? (view.active === null ? 'Asistente de reunión' : 'Reunión en curso'))
  title.setAttribute('data-tauri-drag-region', '')
  const clock = element('span', 'live-clock', elapsedLabel(view.active?.startedAt))
  clock.dataset['clock'] = 'meeting'
  const spacer = element('span', 'spacer')
  spacer.setAttribute('data-tauri-drag-region', '')
  const badge = element('span', 'live-private')
  badge.title = 'Esta ventana no aparece cuando compartes pantalla'
  badge.append(icon('eyeOff', 12), element('span', '', 'Privada'))
  const widen = document.createElement('button')
  widen.type = 'button'
  widen.className = 'live-icon'
  widen.title = 'Abrir en Reuniones'
  widen.setAttribute('aria-label', 'Abrir la reunión en la ventana de Den')
  widen.append(icon('expand', 14))
  widen.addEventListener('click', () => {
    void liveModeSet('wide')
  })
  const hide = document.createElement('button')
  hide.type = 'button'
  hide.className = 'live-icon'
  hide.setAttribute('aria-label', 'Ocultar')
  hide.append(icon('minus', 14))
  hide.addEventListener('click', () => {
    void liveHide()
  })
  bar.append(dot, title, clock, spacer, badge, widen, hide)
  return bar
}

function transcriptPanel(full: boolean): HTMLElement {
  const view = session.view
  const current = session.current
  const section = element('section', full ? 'live-tail live-tail--full' : 'live-tail')
  section.setAttribute('aria-label', 'Transcripción en vivo')
  const settled = current !== null && (current.done !== null || current.error !== null)
  if (full) {
    const head = element('div', 'live-label')
    head.append(icon('bars', 11), element('span', '', 'TRANSCRIPCIÓN EN VIVO'), element('span', 'spacer'))
    const delay = delayLabel(view.active?.startedAt, view.transcript)
    if (delay !== null) head.append(element('span', 'live-delay', delay))
    section.append(head)
  } else if (!settled) {
    const head = element('div', 'live-label')
    head.append(icon('bars', 11), element('span', '', 'TRANSCRIPCIÓN EN VIVO'))
    section.append(head)
  }
  const lines = view.transcript
  if (lines.length === 0) {
    section.append(element('p', 'live-quiet', view.active === null ? 'No se está grabando ninguna reunión.' : 'Esperando las primeras frases…'))
    return section
  }
  const shown = full ? lines : lines.slice(settled ? -1 : -3)
  const list = element('div', 'live-lines')
  shown.forEach((segment, index) => {
    list.append(transcriptLine(segment, !full && index === shown.length - 1, view.active?.mode))
  })
  section.append(list)
  if (full) {
    const typing = element('div', 'live-typing')
    typing.append(element('i', ''), element('i', ''), element('i', ''))
    section.append(typing)
    queueMicrotask(() => {
      list.scrollTop = list.scrollHeight
    })
  }
  return section
}

function card(question: string, state: {
  progress: string | null
  text: string
  sources: AnswerSource[]
  answer: LiveAnswer | null
  error: { code: string; message: string } | null
  auto: boolean
}): HTMLElement {
  const box = element('article', 'live-card')
  const head = element('div', 'live-question')
  const mark = icon('question', 14)
  mark.classList.add('live-question-mark')
  head.append(mark, element('span', 'live-question-text', question.length > 0 ? question : 'Buscando la última pregunta…'))
  if (state.auto) head.append(autoBadge())
  box.append(head)

  const streaming = state.answer === null && state.error === null
  if (streaming && state.progress !== null) {
    const line = element('div', 'live-progress')
    const spin = icon('spinner', 12)
    spin.classList.add('live-spin')
    line.append(spin, element('span', 'live-progress-path', state.progress))
    box.append(line)
  } else if (streaming && state.text.length === 0) {
    const line = element('div', 'live-progress')
    const spin = icon('spinner', 12)
    spin.classList.add('live-spin')
    line.append(spin, element('span', '', state.auto ? 'Buscando…' : 'Pensando'))
    box.append(line)
  }

  if (state.error !== null) {
    const failure = element('div', 'live-missing live-missing--error')
    failure.append(icon('warning', 14))
    const words = element('div', 'live-missing-text')
    words.append(element('span', 'live-missing-title', 'No pude responder'), element('span', '', state.error.message))
    failure.append(words)
    box.append(failure)
    return box
  }

  const found = state.answer?.found ?? true
  if (!found && state.answer !== null) {
    const missing = element('div', 'live-missing')
    missing.append(icon('warning', 14))
    const words = element('div', 'live-missing-text')
    words.append(element('span', 'live-missing-title', 'No está documentado'))
    if (state.answer.answer.trim().length > 0) words.append(markdown(state.answer.answer, false, copy))
    missing.append(words)
    box.append(missing)
  } else if (state.text.length > 0 || state.answer !== null) {
    box.append(markdown(state.answer?.answer ?? state.text, streaming, copy))
  }

  const sources = state.answer?.sources ?? state.sources
  if (sources.length > 0 || (!found && state.answer !== null)) {
    const row = element('div', found ? 'live-sources' : 'live-sources live-sources--plain')
    for (const source of sources) row.append(sourceChip(source, actions))
    if (!found && state.answer !== null) {
      const answer = state.answer
      row.append(element('span', 'spacer'), backlogButton(session.backlogState(answer), () => session.toBacklog(answer)))
    }
    box.append(row)
  }
  return box
}

function collapsed(answer: LiveAnswer): HTMLElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'live-earlier'
  const count = answer.sources.length
  button.append(
    element('span', 'live-stamp', askedClock(answer, session.view.active?.startedAt)),
    element('span', 'live-earlier-question', answer.question),
    ...(answer.auto === true ? [autoBadge()] : []),
    element(
      'span',
      answer.found ? 'live-earlier-count' : 'live-earlier-count live-earlier-count--missing',
      answer.found ? `${count} ${count === 1 ? 'fuente' : 'fuentes'}` : 'sin fuente',
    ),
  )
  button.addEventListener('click', () => {
    session.focus = answer.id
    session.current = null
    paint()
  })
  return button
}

function pendingRow(pending: PendingAsk): HTMLElement {
  const row = element('div', pending.state === 'queued' ? 'live-pending live-pending--queued' : 'live-pending')
  const status = element('span', 'live-pending-status')
  status.append(pendingMark(pending.state, 11), element('span', '', pendingLabel(pending.state)))
  const question = pending.question ?? 'Buscando la última pregunta…'
  const text = element('span', 'live-pending-question', question)
  text.title = question
  row.append(status, text, pending.auto ? autoBadge() : manualBadge())
  return row
}

function pendingStack(pending: PendingAsk[]): HTMLElement {
  const stack = element('section', 'live-pending-stack')
  stack.setAttribute('aria-label', 'Preguntas en curso')
  stack.setAttribute('aria-live', 'polite')
  for (const ask of [...pending].reverse()) stack.append(pendingRow(ask))
  return stack
}

function hintCard(): HTMLElement {
  const view = session.view
  const box = element('div', 'live-hint')
  box.append(icon('keyboard', 14))
  const words = element('div', 'live-hint-text')
  words.append(element('span', 'live-hint-title', view.active === null ? 'Sin reunión en curso' : 'Sin preguntas todavía'))
  const where =
    view.project === null
      ? 'Se busca en las páginas de inkwell y en los repos del proyecto.'
      : repoCount === null
        ? `Se busca en las páginas de ${view.project} y en sus repos.`
        : `Se busca en las páginas de ${view.project} y en ${repoCount === 1 ? 'su repo' : `sus ${repoCount} repos`}.`
  words.append(
    element(
      'span',
      'live-hint-note',
      view.active === null
        ? 'Cuando recap empiece a grabar, aquí aparece la transcripción en vivo.'
        : `Cuando te pregunten algo, pulsa el atajo. ${where}`,
    ),
  )
  box.append(words)
  return box
}

function answersPanel(): HTMLElement {
  const view = session.view
  const current = session.current
  const list = element('main', 'live-answers')
  const doneId = current?.done?.id ?? null
  const shownId = current === null ? (session.focus ?? view.answers.at(-1)?.id ?? null) : doneId
  const pending = session.pendingAsks()
  if (pending.length > 0) list.append(pendingStack(pending))
  if (current !== null) {
    list.append(
      card(current.question, {
        progress: current.progress,
        text: current.text,
        sources: current.sources,
        answer: current.done,
        error: current.error,
        auto: false,
      }),
    )
  } else {
    const shown = view.answers.find((answer) => answer.id === shownId)
    if (shown !== undefined) {
      list.append(
        card(shown.question, { progress: null, text: shown.answer, sources: shown.sources, answer: shown, error: null, auto: shown.auto === true }),
      )
    }
  }
  const earlier = view.answers.filter((answer) => answer.id !== shownId).reverse()
  if (earlier.length > 0) {
    const label = element('div', 'live-label live-label--rule')
    label.append(element('span', '', 'ANTES EN ESTA REUNIÓN'), element('span', 'live-rule'))
    list.append(label)
    for (const answer of earlier) list.append(collapsed(answer))
  }
  return list
}

function askBox(): HTMLElement {
  const view = session.view
  const foot = element('footer', 'live-foot')
  const form = document.createElement('form')
  form.className = 'live-ask'
  const label = element('label', 'visually-hidden', 'Pregunta')
  label.setAttribute('for', 'live-question')
  const input = document.createElement('input')
  input.id = 'live-question'
  input.type = 'text'
  input.placeholder = 'Escribe una pregunta…'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.value = draft
  input.disabled = view.active === null
  input.addEventListener('input', () => {
    draft = input.value
  })
  const send = document.createElement('button')
  send.type = 'submit'
  send.className = 'live-send'
  send.setAttribute('aria-label', 'Preguntar')
  send.disabled = view.active === null
  send.append(icon('send', 14))
  form.append(label, input, send)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const question = draft.trim()
    if (question.length === 0) return
    draft = ''
    session.ask(question)
  })
  const hint = element('div', 'live-shortcut')
  hint.append(element('span', 'live-kbd', shortcutLabel(view.shortcut)), element('span', '', 'responde lo último que se preguntó'))
  if (notice !== null) hint.append(element('span', 'spacer'), element('span', 'live-notice', notice))
  foot.append(form, hint)
  return foot
}

function paint(): void {
  const answers = element('div', 'live-body')
  const idle = session.current === null && session.view.answers.length === 0 && session.pendingAsks().length === 0
  if (idle) {
    answers.append(transcriptPanel(true), hintCard())
  } else {
    answers.append(transcriptPanel(false), answersPanel())
  }
  const focused = document.activeElement?.id === 'live-question'
  const caret = focused ? (document.activeElement as HTMLInputElement).selectionStart : null
  const scroller = root.querySelector<HTMLElement>('.live-answers')
  const scroll = scroller?.scrollTop ?? 0
  root.replaceChildren(header(), answers, askBox())
  const next = root.querySelector<HTMLElement>('.live-answers')
  if (next !== null) next.scrollTop = scroll
  if (focused) {
    const input = root.querySelector<HTMLInputElement>('#live-question')
    input?.focus()
    if (input !== null && caret !== null) input.setSelectionRange(caret, caret)
  }
}

async function loadSources(): Promise<void> {
  const project = session.view.project
  if (project === null || project === sourcesFor) return
  sourcesFor = project
  try {
    const sources = await liveSources(project)
    repoCount = sources === null ? null : sources.repos.filter((repo) => repo.exists).length
  } catch {
    repoCount = null
  }
  paint()
}

function tick(): void {
  const view = session.view
  const clock = root.querySelector<HTMLElement>('[data-clock="meeting"]')
  if (clock !== null) clock.textContent = elapsedLabel(view.active?.startedAt)
  const delay = root.querySelector<HTMLElement>('.live-delay')
  if (delay !== null) delay.textContent = delayLabel(view.active?.startedAt, view.transcript) ?? ''
}

session.listen()
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') void liveHide()
})
window.setInterval(tick, 1000)
paint()
void session.reload()
