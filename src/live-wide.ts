import {
  liveModeSet,
  navigate,
  liveTranscriptFull,
  recapConfig,
  type AnswerSource,
  type LiveAnswer,
  type LiveConfig,
  type LiveTranscriptUpdate,
  type MeetingSegment,
} from './bita.ts'
import { element, icon, must } from './dom.ts'
import { originOf, type Origin } from './live/origin.ts'
import {
  askedClock,
  autoBadge,
  backlogButton,
  channelLabel,
  clockOf,
  elapsedLabel,
  manualBadge,
  markdown,
  offsetOf,
  pendingLabel,
  pendingMark,
  questionKey,
  responseTime,
  sourceAction,
  sourceIcon,
  sourceKind,
  transcriptLine,
  type SourceActions,
} from './live/render.ts'
import { Session } from './live/session.ts'
import { attachSash } from './notes/sash.ts'
import { shortcutLabel } from './shortcut.ts'

type Filter = 'all' | 'auto' | 'manual'
type ItemState = 'searching' | 'answered' | 'missing' | 'failed'

interface Item {
  key: string
  question: string
  versions: LiveAnswer[]
  auto: boolean
  state: ItemState
  queued: boolean
  streaming: 'manual' | 'pending' | null
  origin: Origin
  sortMs: number
  tieMs: number
}

interface PendingTarget {
  id: string | null
  question: string
}

const STACKED_QUERY = '(max-width: 1100px)'
const PENDING_KEY = '\u0000pending'
const ASK_PREFIX = '\u0000ask:'
const PICK_HOLD_MS = 30_000
const COPIED_MS = 1400
const FOLLOW_SLACK_PX = 32
const MODALITY: Record<string, string> = { remote: 'Remota', 'in-person': 'Presencial' }
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'Todas' },
  { id: 'auto', label: 'Detectadas' },
  { id: 'manual', label: 'Manuales' },
]

const bar = must<HTMLElement>('#wide-bar')
const questionsHost = must<HTMLElement>('#wide-questions')
const answerHost = must<HTMLElement>('#wide-answer')
const transcriptHost = must<HTMLElement>('#wide-transcript')
const columns = must<HTMLElement>('#wide-columns')
const stacked = window.matchMedia(STACKED_QUERY)

let lines: MeetingSegment[] = []
let items: Item[] = []
let config: LiveConfig | null = null
let filter: Filter = 'all'
let selected: string | null = null
let pickedAt = 0
let known = new Set<string>()
let versionCounts = new Map<string, number>()
let chosenVersion = new Map<string, string>()
let pendingTargets = new Map<string, PendingTarget>()
let following = true
let scrolling = false
let draft = ''
let notice: string | null = null
let noticeTimer = 0
const painted = { bar: '', list: '', answer: '', marks: '' }

const session = new Session({
  paint,
  flash,
  meetingChanged: () => {
    lines = []
    known = new Set()
    versionCounts = new Map()
    chosenVersion = new Map()
    pendingTargets = new Map()
    selected = null
    following = true
    resetTranscript()
    void loadFull()
  },
  transcript: received,
})
const actions: SourceActions = { copy: (text) => session.copy(text), fail: flash }
const copy = (text: string): void => session.copy(text)

function flash(message: string): void {
  notice = message
  window.clearTimeout(noticeTimer)
  noticeTimer = window.setTimeout(() => {
    notice = null
    paintFooter()
  }, COPIED_MS)
  paintFooter()
}

function startedAt(): string | null {
  return session.view.active?.startedAt ?? null
}

function buildItems(): Item[] {
  const view = session.view
  const groups = new Map<string, Item>()
  for (const answer of view.answers) {
    const key = questionKey(answer.question)
    let item = groups.get(key)
    if (item === undefined) {
      const origin = originOf(
        { question: answer.question, questionMs: answer.questionMs, channel: answer.channel, askedAt: answer.askedAt, startedAt: startedAt() },
        lines,
      )
      item = {
        key,
        question: answer.question,
        versions: [],
        auto: answer.auto === true,
        state: 'answered',
        queued: false,
        streaming: null,
        origin,
        sortMs: origin.ms ?? offsetOf(answer.askedAt, startedAt()) ?? 0,
        tieMs: timeOf(answer.askedAt),
      }
      groups.set(key, item)
    }
    item.versions.push(answer)
    item.state = answer.found ? 'answered' : 'missing'
  }

  const live = (key: string, question: string, auto: boolean, origin: Origin): Item => {
    const existing = groups.get(key)
    if (existing !== undefined) return existing
    const item: Item = {
      key,
      question,
      versions: [],
      auto,
      state: 'searching',
      queued: false,
      streaming: null,
      origin,
      sortMs: origin.ms ?? Number.MAX_SAFE_INTEGER,
      tieMs: Number.MAX_SAFE_INTEGER,
    }
    groups.set(key, item)
    return item
  }

  for (const pending of session.pendingAsks()) {
    const question = pending.question ?? ''
    const key = `${ASK_PREFIX}${pending.id ?? `${pending.auto ? 'auto' : 'manual'}:${pending.startedAt ?? ''}`}`
    const origin = originOf(
      { question, questionMs: pending.questionMs, channel: pending.channel, askedAt: pending.startedAt, startedAt: startedAt() },
      lines,
    )
    pendingTargets.set(key, { id: pending.id, question })
    const item = live(key, question, pending.auto, origin)
    item.queued = pending.state === 'queued'
    item.streaming = 'pending'
    item.tieMs = timeOf(pending.startedAt)
  }

  const current = session.current
  if (current !== null && current.done === null) {
    const question = current.question.trim()
    const origin = originOf({ question, askedAt: current.startedAt, startedAt: startedAt() }, lines)
    const item = live(question.length === 0 ? PENDING_KEY : questionKey(question), question, false, origin)
    item.state = current.error === null ? 'searching' : 'failed'
    item.streaming = current.error === null ? 'manual' : null
  }

  return [...groups.values()].sort((left, right) => right.sortMs - left.sortMs || right.tieMs - left.tieMs)
}

function timeOf(iso: string | null | undefined): number {
  const ms = iso === null || iso === undefined ? Number.NaN : new Date(iso).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function landedKey(target: PendingTarget): string | null {
  const id = target.id
  const answer = id === null ? undefined : session.view.answers.find((candidate) => candidate.askId === id)
  if (answer !== undefined) return questionKey(answer.question)
  return target.question.trim().length > 0 ? questionKey(target.question) : null
}

function choose(next: Item[]): void {
  const fresh = next.filter((item) => !known.has(item.key))
  for (const item of next) known.add(item.key)
  for (const item of next) {
    const count = item.versions.length
    if ((versionCounts.get(item.key) ?? count) !== count) chosenVersion.delete(item.key)
    versionCounts.set(item.key, count)
  }
  const current = session.current
  if (selected === PENDING_KEY && !next.some((item) => item.key === PENDING_KEY) && current !== null && current.question.trim().length > 0) {
    selected = questionKey(current.question)
  }
  const target = selected === null ? undefined : pendingTargets.get(selected)
  if (selected !== null && target !== undefined && !next.some((item) => item.key === selected)) {
    const landed = landedKey(target)
    pendingTargets.delete(selected)
    if (landed !== null && next.some((item) => item.key === landed)) selected = landed
  }
  for (const key of pendingTargets.keys()) {
    if (key !== selected && !next.some((item) => item.key === key)) pendingTargets.delete(key)
  }
  const first = fresh[0]
  if (first !== undefined && (selected === null || Date.now() - pickedAt > PICK_HOLD_MS)) selected = first.key
  if (selected === null || !next.some((item) => item.key === selected)) selected = next[0]?.key ?? null
}

function shown(): Item[] {
  if (filter === 'all') return items
  return items.filter((item) => (filter === 'auto') === item.auto)
}

function selectedItem(): Item | undefined {
  return items.find((item) => item.key === selected)
}

function versionOf(item: Item): LiveAnswer | undefined {
  const chosen = chosenVersion.get(item.key)
  return item.versions.find((answer) => answer.id === chosen) ?? item.versions.at(-1)
}

function pick(key: string): void {
  selected = key
  pickedAt = Date.now()
  paint()
  const item = selectedItem()
  if (item !== undefined && item.origin.line !== null) revealLine(item.origin.line)
}

function paintBar(): void {
  const view = session.view
  const signature = JSON.stringify([view.title, view.project, view.active?.meetingId, view.active?.mode, config?.autoAsk, config === null])
  if (signature === painted.bar) return
  painted.bar = signature
  const dot = element('span', view.active === null ? 'live-dot live-dot--idle' : 'live-dot')
  const title = element('span', 'wide-title', view.title ?? (view.active === null ? 'Asistente de reunión' : 'Reunión en curso'))
  title.setAttribute('data-tauri-drag-region', '')
  const parts = [view.project, view.active?.mode === undefined || view.active.mode === null ? null : (MODALITY[view.active.mode] ?? null)]
  const sub = element('span', 'wide-sub', parts.filter((part): part is string => part !== null).join(' · '))
  sub.setAttribute('data-tauri-drag-region', '')
  const clock = element('span', 'wide-clock', elapsedLabel(view.active?.startedAt))
  clock.dataset['clock'] = 'meeting'
  const spacer = element('span', 'spacer')
  spacer.setAttribute('data-tauri-drag-region', '')
  const badge = element('span', 'live-private')
  badge.title = 'Esta ventana no aparece cuando compartes pantalla'
  badge.append(icon('eyeOff', 12), element('span', '', 'Privada'))
  bar.replaceChildren(dot, title, sub, clock, spacer, badge)
  if (config !== null) {
    const on = config.autoAsk === true
    const status = document.createElement('button')
    status.type = 'button'
    status.className = on ? 'wide-detect wide-detect--on' : 'wide-detect'
    status.title = 'Abrir los ajustes del asistente'
    status.append(element('span', 'wide-detect-dot'), element('span', '', on ? 'Detección automática' : 'Detección apagada'))
    status.addEventListener('click', () => {
      void navigate('ajustes/asistente')
    })
    bar.append(status)
  }
  const compact = document.createElement('button')
  compact.type = 'button'
  compact.className = 'wide-compact'
  compact.title = 'Volver a la ventana flotante'
  compact.append(icon('shrink', 13), element('span', '', 'Compacta'))
  compact.addEventListener('click', () => {
    void liveModeSet('compact')
  })
  bar.append(compact)
}

function statusOf(item: Item): HTMLElement {
  if (item.state === 'searching') {
    const phase = item.queued ? 'queued' : 'running'
    const status = element('span', item.queued ? 'wide-status wide-status--queued' : 'wide-status wide-status--searching')
    status.append(pendingMark(phase, 11), element('span', '', pendingLabel(phase)))
    return status
  }
  if (item.state === 'answered') return element('span', 'wide-status wide-status--answered', 'Respondida')
  if (item.state === 'missing') return element('span', 'wide-status wide-status--missing', 'Sin fuente')
  return element('span', 'wide-status wide-status--missing', 'Sin respuesta')
}

function questionButton(item: Item): HTMLElement {
  const classes = ['wide-item']
  if (item.key === selected) classes.push('wide-item--selected')
  else if (item.state === 'searching') classes.push('wide-item--live')
  const button = document.createElement('button')
  button.type = 'button'
  button.className = classes.join(' ')
  button.dataset['key'] = item.key
  button.setAttribute('aria-pressed', String(item.key === selected))
  const meta = element('span', 'wide-item-meta')
  meta.append(
    element('span', 'wide-item-stamp', item.origin.ms === null ? '--:--' : clockOf(item.origin.ms)),
    statusOf(item),
    element('span', 'spacer'),
    item.auto ? autoBadge() : manualBadge(),
  )
  if (item.versions.length > 1) meta.append(element('span', 'wide-item-versions', `×${item.versions.length}`))
  button.append(meta, element('span', 'wide-item-question', item.question.length > 0 ? item.question : 'Buscando la última pregunta…'))
  button.addEventListener('click', () => pick(item.key))
  return button
}

function paintList(): void {
  const visible = shown()
  const signature = JSON.stringify([
    filter,
    selected,
    items.length,
    visible.map((item) => [item.key, item.question, item.state, item.queued, item.auto, item.versions.length, item.origin.ms]),
  ])
  if (signature === painted.list) return
  painted.list = signature
  const head = element('div', 'wide-questions-head')
  const title = element('div', 'wide-heading')
  title.append(element('span', 'wide-label', 'PREGUNTAS'), element('span', 'wide-count', String(items.length)))
  const filters = element('div', 'wide-filters')
  filters.setAttribute('role', 'group')
  filters.setAttribute('aria-label', 'Filtrar preguntas')
  for (const option of FILTERS) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = option.id === filter ? 'wide-filter wide-filter--on' : 'wide-filter'
    button.setAttribute('aria-pressed', String(option.id === filter))
    button.textContent = option.label
    button.addEventListener('click', () => {
      filter = option.id
      paint()
    })
    filters.append(button)
  }
  head.append(title, filters)
  const list = element('div', 'wide-list')
  if (visible.length === 0) {
    list.append(
      element(
        'p',
        'wide-empty',
        items.length === 0
          ? 'Aquí aparecen las preguntas que detecta el asistente y las que haces tú.'
          : filter === 'auto'
            ? 'Todavía no se detecta ninguna pregunta.'
            : 'Todavía no haces ninguna pregunta.',
      ),
    )
  }
  for (const item of visible) list.append(questionButton(item))
  const previous = questionsHost.querySelector<HTMLElement>('.wide-list')
  const scroll = previous?.scrollTop ?? 0
  const foot = questionsHost.querySelector<HTMLElement>('.wide-ask-foot') ?? askFooter()
  questionsHost.replaceChildren(head, list, foot)
  list.scrollTop = scroll
}

function askFooter(): HTMLElement {
  const foot = element('div', 'wide-ask-foot')
  const form = document.createElement('form')
  form.className = 'live-ask'
  const label = element('label', 'visually-hidden', 'Pregunta')
  label.setAttribute('for', 'wide-question')
  const input = document.createElement('input')
  input.id = 'wide-question'
  input.type = 'text'
  input.placeholder = 'Escribe una pregunta…'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.addEventListener('input', () => {
    draft = input.value
  })
  const send = document.createElement('button')
  send.type = 'submit'
  send.className = 'live-send'
  send.setAttribute('aria-label', 'Preguntar')
  send.append(icon('send', 14))
  form.append(label, input, send)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    const question = draft.trim()
    if (question.length === 0) return
    draft = ''
    input.value = ''
    selected = questionKey(question)
    pickedAt = Date.now()
    session.ask(question)
  })
  const hint = element('div', 'live-shortcut')
  foot.append(form, hint)
  return foot
}

function paintFooter(): void {
  const foot = questionsHost.querySelector<HTMLElement>('.wide-ask-foot')
  if (foot === null) return
  const idle = session.view.active === null
  const input = foot.querySelector<HTMLInputElement>('input')
  const send = foot.querySelector<HTMLButtonElement>('.live-send')
  if (input !== null) input.disabled = idle
  if (send !== null) send.disabled = idle
  const hint = foot.querySelector<HTMLElement>('.live-shortcut')
  if (hint === null) return
  hint.replaceChildren(element('span', 'live-kbd', shortcutLabel(session.view.shortcut)), element('span', '', 'lo último que se preguntó'))
  if (notice !== null) hint.append(element('span', 'spacer'), element('span', 'live-notice', notice))
}

function sourceRow(source: AnswerSource): HTMLElement {
  const kind = sourceKind(source)
  const row = document.createElement('button')
  row.type = 'button'
  row.className = `wide-source wide-source--${kind}`
  const where = kind === 'page' ? 'página de inkwell' : (source.repo ?? (kind === 'commit' ? 'commit' : 'archivo'))
  row.append(sourceIcon(kind, 14), element('span', 'wide-source-label', source.label), element('span', 'wide-source-where', where))
  const action = sourceAction(source, actions)
  if (action === null) {
    row.disabled = true
  } else {
    row.title = action.title
    row.addEventListener('click', action.run)
  }
  return row
}

function progressLine(text: string, path: boolean): HTMLElement {
  const line = element('div', 'live-progress')
  const spin = icon('spinner', 12)
  spin.classList.add('live-spin')
  line.append(spin, element('span', path ? 'live-progress-path' : '', text))
  return line
}

function failure(title: string, message: string, error: boolean): HTMLElement {
  const box = element('div', error ? 'live-missing live-missing--error' : 'live-missing')
  box.append(icon('warning', 14))
  const words = element('div', 'live-missing-text')
  words.append(element('span', 'live-missing-title', title))
  if (message.length > 0) words.append(element('span', '', message))
  box.append(words)
  return box
}

function actionButton(name: 'copy' | 'rotate', label: string, run: () => void, disabled = false): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'wide-action'
  button.disabled = disabled
  button.append(icon(name, 13), element('span', '', label))
  button.addEventListener('click', run)
  return button
}

function emptyAnswer(): HTMLElement {
  const view = session.view
  const box = element('div', 'live-hint wide-hint')
  box.append(icon('keyboard', 14))
  const words = element('div', 'live-hint-text')
  words.append(
    element('span', 'live-hint-title', view.active === null ? 'Sin reunión en curso' : 'Sin preguntas todavía'),
    element(
      'span',
      'live-hint-note',
      view.active === null
        ? 'Cuando recap empiece a grabar, aquí aparecen las preguntas y sus respuestas.'
        : 'Cuando te pregunten algo, pulsa el atajo o escribe la pregunta. Las que detecte el asistente aparecen solas.',
    ),
  )
  box.append(words)
  return box
}

function answerSignature(item: Item | undefined): string {
  if (item === undefined) return JSON.stringify(['empty', session.view.active?.meetingId ?? null])
  const version = versionOf(item)
  const current = item.streaming === 'manual' || item.state === 'failed' ? session.current : null
  const line = item.origin.line === null ? null : lines[item.origin.line]
  return JSON.stringify([
    item.key,
    item.state,
    item.queued,
    item.streaming,
    item.question,
    item.origin,
    line?.text ?? null,
    item.versions.map((answer) => answer.id),
    version?.id ?? null,
    version === undefined ? null : session.backlogState(version),
    current === null ? null : [current.askId, current.progress, current.text.length, current.sources.length, current.error],
    session.manualStreaming(),
    session.view.active?.mode ?? null,
  ])
}

function paintAnswer(): void {
  const item = selectedItem()
  const signature = answerSignature(item)
  if (signature === painted.answer) return
  painted.answer = signature
  const scroll = answerHost.scrollTop
  if (item === undefined) {
    answerHost.replaceChildren(emptyAnswer())
    return
  }
  const version = versionOf(item)
  const current = session.current
  const streaming = item.streaming !== null
  const body = element('div', 'wide-answer-inner')

  const head = element('div', 'wide-answer-head')
  const meta = element('div', 'wide-meta')
  if (item.origin.ms !== null) meta.append(element('span', 'wide-mono', clockOf(item.origin.ms)))
  if (item.origin.channel !== null && session.view.active?.mode !== 'in-person') {
    meta.append(element('span', '', '·'), element('span', '', `preguntó ${channelLabel(item.origin.channel)}`))
  }
  meta.append(item.auto ? autoBadge() : manualBadge(), element('span', 'spacer'))
  const took = streaming || version === undefined ? null : responseTime(version)
  if (took !== null) meta.append(element('span', 'wide-mono', took))
  head.append(meta, element('h1', 'wide-question', item.question.length > 0 ? item.question : 'Buscando la última pregunta…'))
  body.append(head)

  const said = item.origin.line === null ? undefined : lines[item.origin.line]
  if (said !== undefined) {
    const quote = transcriptLine(said, false, session.view.active?.mode)
    quote.className = 'wide-quote'
    quote.title = 'Ir a esta línea de la transcripción'
    const index = item.origin.line
    quote.addEventListener('click', () => {
      if (index !== null) revealLine(index)
    })
    body.append(quote)
  }

  const content = element('div', 'wide-body')
  let sources: AnswerSource[] = version?.sources ?? []
  if (item.streaming === 'manual' && current !== null) {
    sources = current.sources
    if (current.progress !== null) content.append(progressLine(current.progress, true))
    else if (current.text.length === 0) content.append(progressLine('Pensando', false))
    if (current.text.length > 0) content.append(markdown(current.text, true, copy))
  } else if (item.streaming === 'pending' && item.queued) {
    const line = element('div', 'live-progress wide-queued')
    line.append(pendingMark('queued', 12), element('span', '', 'En cola: empieza en cuanto termine otra respuesta'))
    content.append(line)
  } else if (item.streaming === 'pending') {
    content.append(progressLine('Buscando…', false))
  } else {
    if (item.state === 'failed' && current !== null && current.error !== null) {
      content.append(failure('No pude responder', current.error.message, true))
    }
    if (version !== undefined && !version.found) {
      content.append(failure('No está documentado', '', false))
      if (version.answer.trim().length > 0) content.append(markdown(version.answer, false, copy))
    } else if (version !== undefined) {
      content.append(markdown(version.answer, false, copy))
    }
  }
  body.append(content)

  if (sources.length > 0) {
    const block = element('div', 'wide-sources')
    const rows = element('div', 'wide-source-rows')
    for (const source of sources) rows.append(sourceRow(source))
    block.append(element('span', 'wide-label', 'FUENTES'), rows)
    body.append(block)
  }

  if (item.versions.length > 1) {
    const block = element('div', 'wide-versions')
    const group = element('div', 'wide-filters')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', 'Versiones de la respuesta')
    item.versions.forEach((answer, index) => {
      const button = document.createElement('button')
      button.type = 'button'
      const on = !streaming && answer.id === version?.id
      button.className = on ? 'wide-filter wide-filter--on' : 'wide-filter'
      button.setAttribute('aria-pressed', String(on))
      button.append(element('span', '', `Versión ${index + 1}`), element('span', 'wide-version-time', askedClock(answer, startedAt())))
      button.addEventListener('click', () => {
        chosenVersion.set(item.key, answer.id)
        paint()
      })
      group.append(button)
    })
    block.append(element('span', 'wide-label', 'VERSIONES'), group)
    body.append(block)
  }

  if (version !== undefined && !streaming) {
    const busy = session.manualStreaming()
    const row = element('div', 'wide-actions')
    row.append(
      actionButton('copy', 'Copiar respuesta', () => copy(version.answer)),
      actionButton(
        'rotate',
        'Volver a responder',
        () => {
          selected = item.key
          pickedAt = Date.now()
          session.ask(item.question)
        },
        busy || session.view.active === null,
      ),
      backlogButton(session.backlogState(version), () => session.toBacklog(version), 'wide-action'),
    )
    body.append(row)
  }

  answerHost.replaceChildren(body)
  answerHost.scrollTop = scroll
}

function transcriptRow(segment: MeetingSegment, index: number): HTMLElement {
  const row = transcriptLine(segment, false, session.view.active?.mode)
  row.classList.add('wide-line')
  row.dataset['index'] = String(index)
  return row
}

function transcriptList(): HTMLElement | null {
  return transcriptHost.querySelector<HTMLElement>('.wide-lines')
}

function placeCaret(list: HTMLElement): void {
  list.querySelector('.wide-caret')?.remove()
  if (session.view.active === null) return
  const said = list.lastElementChild?.querySelector('.live-said')
  if (said !== null && said !== undefined) said.append(element('span', 'live-caret wide-caret'))
}

function followButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'wide-follow'
  button.addEventListener('click', () => {
    following = !following
    syncFollow()
    if (following) toBottom()
  })
  return button
}

function syncFollow(): void {
  const button = transcriptHost.querySelector<HTMLButtonElement>('.wide-follow')
  if (button === null) return
  button.classList.toggle('wide-follow--on', following)
  button.setAttribute('aria-pressed', String(following))
  button.title = following ? 'La transcripción baja sola con cada frase nueva' : 'Volver a seguir la transcripción'
  button.replaceChildren(element('span', 'wide-follow-dot'), element('span', '', following ? 'Siguiendo' : 'Seguir'))
}

function toBottom(): void {
  const list = transcriptList()
  if (list === null) return
  scrolling = true
  list.scrollTop = list.scrollHeight
  requestAnimationFrame(() => {
    scrolling = false
  })
}

function revealLine(index: number): void {
  const row = transcriptHost.querySelector<HTMLElement>(`.wide-line[data-index="${index}"]`)
  if (row === null) return
  following = false
  syncFollow()
  const list = transcriptList()
  if (list === null) return
  scrolling = true
  const top = row.offsetTop - (list.clientHeight - row.offsetHeight) / 2
  list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  window.setTimeout(() => {
    scrolling = false
  }, 600)
}

function buildTranscript(): void {
  const head = element('div', 'wide-transcript-head')
  head.append(icon('bars', 12), element('span', 'wide-label', 'TRANSCRIPCIÓN EN VIVO'), element('span', 'spacer'), followButton())
  const list = element('div', 'wide-lines')
  list.addEventListener('scroll', () => {
    if (scrolling) return
    const near = list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_SLACK_PX
    if (near !== following) {
      following = near
      syncFollow()
    }
  })
  list.addEventListener('click', (event) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>('.wide-line--question')
    const key = row?.dataset['question']
    if (key !== undefined) pick(key)
  })
  const legend = element('div', 'wide-legend')
  legend.append(
    element('span', 'wide-legend-bar'),
    element('span', '', 'pregunta detectada'),
    element('span', 'wide-legend-box'),
    element('span', '', 'la que se muestra'),
  )
  transcriptHost.replaceChildren(head, list, legend)
  syncFollow()
}

function resetTranscript(): void {
  const list = transcriptList()
  if (list === null) return
  if (lines.length === 0) {
    list.replaceChildren(
      element('p', 'live-quiet', session.view.active === null ? 'No se está grabando ninguna reunión.' : 'Esperando las primeras frases…'),
    )
  } else {
    list.replaceChildren(...lines.map((segment, index) => transcriptRow(segment, index)))
    placeCaret(list)
  }
  painted.marks = ''
  markTranscript()
  if (following) toBottom()
}

function appendTranscript(from: number, added: MeetingSegment[]): void {
  const list = transcriptList()
  if (list === null) return
  if (from === 0 || list.querySelector('.wide-line') === null) {
    resetTranscript()
    return
  }
  list.append(...added.map((segment, index) => transcriptRow(segment, from + index)))
  placeCaret(list)
  painted.marks = ''
  markTranscript()
  if (following) toBottom()
}

function markTranscript(): void {
  const current = selectedItem()
  const marks = items.filter((item) => item.origin.line !== null).map((item) => [item.origin.line, item.key, item.auto])
  const signature = JSON.stringify([marks, current?.origin.line ?? null])
  if (signature === painted.marks) return
  painted.marks = signature
  for (const row of transcriptHost.querySelectorAll<HTMLElement>('.wide-line--question, .wide-line--selected')) {
    row.classList.remove('wide-line--question', 'wide-line--detected', 'wide-line--selected')
    delete row.dataset['question']
  }
  for (const item of items) {
    if (item.origin.line === null) continue
    const row = transcriptHost.querySelector<HTMLElement>(`.wide-line[data-index="${item.origin.line}"]`)
    if (row === null) continue
    row.classList.add('wide-line--question')
    if (item.auto) row.classList.add('wide-line--detected')
    row.dataset['question'] = item.key
  }
  if (current !== undefined && current.origin.line !== null) {
    transcriptHost.querySelector<HTMLElement>(`.wide-line[data-index="${current.origin.line}"]`)?.classList.add('wide-line--selected')
  }
}

function received(update: LiveTranscriptUpdate): void {
  if (update.from === lines.length) {
    lines = lines.concat(update.lines)
    appendTranscript(update.from, update.lines)
  } else if (update.from === 0) {
    lines = update.lines
    resetTranscript()
  } else {
    void loadFull()
    return
  }
  paint()
}

async function loadFull(): Promise<void> {
  const meeting = session.view.active?.meetingId ?? null
  let full: MeetingSegment[] = []
  try {
    const response = await liveTranscriptFull()
    if (response !== null && response.meetingId === meeting) full = response.transcript
  } catch {
    full = session.view.transcript
  }
  if ((session.view.active?.meetingId ?? null) !== meeting) return
  lines = full
  resetTranscript()
  paint()
}

async function loadConfig(): Promise<void> {
  try {
    config = await recapConfig()
  } catch {
    config = null
  }
  paintBar()
}

function paint(): void {
  items = buildItems()
  choose(items)
  paintBar()
  paintList()
  paintFooter()
  paintAnswer()
  markTranscript()
}

function move(step: number): void {
  const visible = shown()
  if (visible.length === 0) return
  const index = visible.findIndex((item) => item.key === selected)
  const next = visible[Math.min(visible.length - 1, Math.max(0, index === -1 ? 0 : index + step))]
  if (next === undefined || next.key === selected) return
  pick(next.key)
  const list = questionsHost.querySelector<HTMLElement>('.wide-list')
  const row = questionsHost.querySelector<HTMLElement>('.wide-item--selected')
  if (list === null || row === null) return
  const top = row.offsetTop
  if (top < list.scrollTop) list.scrollTop = top - 8
  else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight + 8
}

function tick(): void {
  const clock = bar.querySelector<HTMLElement>('[data-clock="meeting"]')
  if (clock !== null) clock.textContent = elapsedLabel(session.view.active?.startedAt)
}

function attachSashes(): void {
  attachSash({
    handle: must<HTMLElement>('#sash-questions'),
    root: columns,
    variable: '--questions-open',
    side: 'left',
    storageKey: 'bita.live.questions-width',
    initial: 280,
    min: 220,
    max: 440,
    readerMin: 420,
    otherWidth: () => (stacked.matches ? 0 : transcriptHost.getBoundingClientRect().width),
  })
  attachSash({
    handle: must<HTMLElement>('#sash-transcript'),
    root: columns,
    variable: '--transcript-open',
    side: 'right',
    storageKey: 'bita.live.transcript-width',
    initial: 340,
    min: 260,
    max: 560,
    readerMin: 420,
    otherWidth: () => questionsHost.getBoundingClientRect().width,
  })
}

function boot(): void {
  buildTranscript()
  resetTranscript()
  attachSashes()
  session.listen()
  document.addEventListener('keydown', (event) => {
    const target = event.target as HTMLElement | null
    if (target !== null && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
    if (event.metaKey || event.ctrlKey || event.altKey) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    }
  })
  window.addEventListener('focus', () => {
    void loadConfig()
  })
  window.setInterval(tick, 1000)
  paint()
  void session.reload()
  void loadConfig()
}

boot()
