import { getCurrentWindow } from '@tauri-apps/api/window'
import {
  describeProblem,
  liveTranscriptFull,
  navigate,
  recapConfig,
  stopTimer,
  type AnswerSource,
  type LiveAnswer,
  type LiveConfig,
  type LiveTranscriptUpdate,
  type MeetingSegment,
} from '../../bita.ts'
import { element, icon } from '../../dom.ts'
import { originOf, type Origin } from '../../live/origin.ts'
import {
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
} from '../../live/render.ts'
import { Session } from '../../live/session.ts'
import { shortcutLabel } from '../../shortcut.ts'
import '../../live/live.css'

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

export interface LiveHooks {
  changed: () => void
  fullscreen: (on: boolean) => void
}

export interface LiveMeetingView {
  root: HTMLElement
  session: Session
  start: () => void
  shown: () => void
  dispose: () => void
}

const PENDING_KEY = '\u0000pending'
const ASK_PREFIX = '\u0000ask:'
const FOLLOW_SLACK_PX = 32
const NOTICE_MS = 1600
const CONFIRM_MS = 3000
const MODE_LABEL: Record<string, string> = { remote: 'remota', 'in-person': 'presencial', meeting: 'micrófono' }

function timeOf(iso: string | null | undefined): number {
  const ms = iso === null || iso === undefined ? Number.NaN : new Date(iso).getTime()
  return Number.isFinite(ms) ? ms : 0
}

function button(className: string, label: string, children: (Node | string)[], run: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.setAttribute('aria-label', label)
  node.title = label
  node.append(...children)
  node.addEventListener('click', run)
  return node
}

export function createLiveView(hooks: LiveHooks): LiveMeetingView {
  const root = element('section', 'rl')
  root.setAttribute('aria-label', 'Reunión en curso')
  const head = element('header', 'rl-head')
  const body = element('div', 'rl-body')
  const transcript = element('section', 'rl-transcript')
  transcript.setAttribute('aria-label', 'Transcripción en vivo')
  const assist = element('aside', 'rl-assist')
  assist.setAttribute('aria-label', 'Preguntas al asistente')
  const questions = element('div', 'rl-questions')
  const answer = element('div', 'rl-answer')
  const foot = element('footer', 'rl-foot')
  const caption = element('p', 'rl-caption')
  caption.hidden = true
  assist.append(questions, answer)
  body.append(transcript, assist)
  root.append(head, body, foot)

  let lines: MeetingSegment[] = []
  let items: Item[] = []
  let config: LiveConfig | null = null
  let selected: string | null = null
  let known = new Set<string>()
  let following = true
  let scrolling = false
  let captions = false
  let fullscreen = false
  let confirming = false
  let confirmTimer = 0
  let notice: string | null = null
  let noticeTimer = 0
  let clockTimer = 0
  let draft = ''
  const painted = { head: '', list: '', answer: '', marks: '' }

  const session = new Session({
    paint,
    flash,
    meetingChanged: () => {
      lines = []
      known = new Set()
      selected = null
      following = true
      resetTranscript()
      void loadFull()
      hooks.changed()
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
      paintFoot()
    }, NOTICE_MS)
    paintFoot()
  }

  function startedAt(): string | null {
    return session.view.active?.startedAt ?? null
  }

  function buildItems(): Item[] {
    const groups = new Map<string, Item>()
    for (const reply of session.view.answers) {
      const key = questionKey(reply.question)
      let item = groups.get(key)
      if (item === undefined) {
        const origin = originOf(
          { question: reply.question, questionMs: reply.questionMs, channel: reply.channel, askedAt: reply.askedAt, startedAt: startedAt() },
          lines,
        )
        item = {
          key,
          question: reply.question,
          versions: [],
          auto: reply.auto === true,
          state: 'answered',
          queued: false,
          streaming: null,
          origin,
          sortMs: origin.ms ?? offsetOf(reply.askedAt, startedAt()) ?? 0,
          tieMs: timeOf(reply.askedAt),
        }
        groups.set(key, item)
      }
      item.versions.push(reply)
      item.state = reply.found ? 'answered' : 'missing'
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

  function choose(next: Item[]): void {
    const fresh = next.filter((item) => !known.has(item.key))
    for (const item of next) known.add(item.key)
    const current = session.current
    if (selected === PENDING_KEY && !next.some((item) => item.key === PENDING_KEY) && current !== null && current.question.trim().length > 0) {
      selected = questionKey(current.question)
    }
    const first = fresh[0]
    if (first !== undefined) selected = first.key
    if (selected === null || !next.some((item) => item.key === selected)) selected = next[0]?.key ?? null
  }

  function selectedItem(): Item | undefined {
    return items.find((item) => item.key === selected)
  }

  function pick(key: string): void {
    selected = key
    paint()
    const item = selectedItem()
    if (item !== undefined && item.origin.line !== null) revealLine(item.origin.line)
  }

  function subtitle(): string {
    const view = session.view
    if (view.active === null) return ''
    const mode = view.active.mode ?? 'meeting'
    const parts = [elapsedLabel(view.active.startedAt), MODE_LABEL[mode] ?? mode, view.project]
    return parts.filter((part): part is string => part !== null && part.length > 0).join(' · ')
  }

  function endButton(): HTMLButtonElement {
    const entryId = session.view.entryId
    const end = button('rl-end', confirming ? '¿Terminar la reunión?' : 'Terminar', [confirming ? '¿Terminar?' : 'Terminar'], () => {
      if (entryId === null) return
      if (!confirming) {
        confirming = true
        painted.head = ''
        paintHead()
        window.clearTimeout(confirmTimer)
        confirmTimer = window.setTimeout(() => {
          confirming = false
          painted.head = ''
          paintHead()
        }, CONFIRM_MS)
        return
      }
      confirming = false
      window.clearTimeout(confirmTimer)
      void stopTimer(entryId)
        .then(() => flash('Reunión terminada'))
        .catch((error: unknown) => flash(describeProblem(error).message))
        .finally(() => {
          painted.head = ''
          paintHead()
        })
    })
    if (entryId === null) {
      end.disabled = true
      end.title = 'Esta reunión no tiene cronómetro en bita: termínala desde recap'
    }
    return end
  }

  function paintHead(): void {
    const view = session.view
    const signature = JSON.stringify([view.title, view.project, view.active?.meetingId, view.entryId, config?.autoAsk, config === null, captions, fullscreen, confirming])
    if (signature === painted.head) return
    painted.head = signature
    const dot = element('span', view.active === null ? 'rec-dot rec-dot--idle' : 'rec-dot')
    const title = element('h1', 'rl-title', view.title ?? (view.active === null ? 'Sin reunión en curso' : 'Reunión en curso'))
    const sub = element('span', 'rl-sub', subtitle())
    sub.dataset['clock'] = 'meeting'
    const controls = element('div', 'rl-controls')
    if (config !== null) {
      const on = config.autoAsk === true
      controls.append(
        button(on ? 'rl-detect rl-detect--on' : 'rl-detect', 'Abrir los ajustes del asistente', [element('span', 'rl-detect-dot'), on ? 'Detección automática' : 'Detección apagada'], () => {
          void navigate('ajustes/asistente')
        }),
      )
    }
    const captionsButton = button('rl-icon', 'Subtítulos', [icon('captions', 15)], () => {
      captions = !captions
      syncCaption()
      paintHead()
    })
    captionsButton.setAttribute('aria-pressed', String(captions))
    const fullButton = button('rl-icon', fullscreen ? 'Salir de pantalla completa' : 'Pantalla completa', [icon(fullscreen ? 'shrink' : 'fullscreen', 14)], () => {
      void setFullscreen(!fullscreen)
    })
    fullButton.setAttribute('aria-pressed', String(fullscreen))
    controls.append(captionsButton, fullButton)
    if (view.active !== null) controls.append(endButton())
    head.replaceChildren(dot, title, sub, element('span', 'spacer'), controls)
  }

  async function setFullscreen(on: boolean): Promise<void> {
    try {
      await getCurrentWindow().setFullscreen(on)
    } catch (error) {
      flash(describeProblem(error).message)
      return
    }
    fullscreen = on
    root.classList.toggle('rl--full', on)
    hooks.fullscreen(on)
    paintHead()
  }

  function statusOf(item: Item): HTMLElement {
    if (item.state === 'searching') {
      const phase = item.queued ? 'queued' : 'running'
      const status = element('span', 'rl-status rl-status--searching')
      status.append(pendingMark(phase, 11), element('span', '', pendingLabel(phase)))
      return status
    }
    if (item.state === 'answered') return element('span', 'rl-status rl-status--answered', 'Respondida')
    return element('span', 'rl-status rl-status--missing', item.state === 'missing' ? 'Sin fuente' : 'Sin respuesta')
  }

  function paintList(): void {
    const signature = JSON.stringify([selected, items.map((item) => [item.key, item.question, item.state, item.queued, item.versions.length, item.origin.ms])])
    if (signature === painted.list) return
    painted.list = signature
    const heading = element('div', 'rl-label-row')
    heading.append(element('span', 'rl-label', 'Preguntas'), element('span', 'rl-count', String(items.length)))
    const list = element('div', 'rl-list')
    if (items.length === 0) {
      list.append(element('p', 'rl-empty', 'Aquí aparecen las preguntas que detecta el asistente y las que haces tú.'))
    }
    for (const item of items) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = item.key === selected ? 'rl-item rl-item--on' : 'rl-item'
      row.setAttribute('aria-pressed', String(item.key === selected))
      const meta = element('span', 'rl-item-meta')
      meta.append(
        element('span', 'rl-mono', item.origin.ms === null ? '--:--' : clockOf(item.origin.ms)),
        statusOf(item),
        element('span', 'spacer'),
        item.auto ? autoBadge() : manualBadge(),
      )
      row.append(meta, element('span', 'rl-item-question', item.question.length > 0 ? item.question : 'Buscando la última pregunta…'))
      row.addEventListener('click', () => pick(item.key))
      list.append(row)
    }
    const scroll = questions.querySelector<HTMLElement>('.rl-list')?.scrollTop ?? 0
    questions.replaceChildren(heading, list)
    list.scrollTop = scroll
  }

  function sourceRow(source: AnswerSource): HTMLElement {
    const kind = sourceKind(source)
    const row = document.createElement('button')
    row.type = 'button'
    row.className = 'rl-source'
    const where = kind === 'page' ? 'página de inkwell' : (source.repo ?? (kind === 'commit' ? 'commit' : 'archivo'))
    row.append(sourceIcon(kind, 13), element('span', 'rl-source-label', source.label), element('span', 'rl-source-where', where))
    const action = sourceAction(source, actions)
    if (action === null) {
      row.disabled = true
    } else {
      row.title = action.title
      row.addEventListener('click', action.run)
    }
    return row
  }

  function progressLine(text: string): HTMLElement {
    const line = element('div', 'live-progress')
    const spin = icon('spinner', 12)
    spin.classList.add('live-spin')
    line.append(spin, element('span', '', text))
    return line
  }

  function problemBox(title: string, message: string): HTMLElement {
    const box = element('div', 'live-missing')
    const words = element('div', 'live-missing-text')
    words.append(element('span', 'live-missing-title', title))
    if (message.length > 0) words.append(element('span', '', message))
    box.append(icon('warning', 14), words)
    return box
  }

  function paintAnswer(): void {
    const item = selectedItem()
    const current = session.current
    const version = item?.versions.at(-1)
    const signature = JSON.stringify([
      item?.key ?? null,
      item?.state ?? null,
      item?.streaming ?? null,
      item?.queued ?? null,
      version?.id ?? null,
      version === undefined ? null : session.backlogState(version),
      current === null ? null : [current.askId, current.progress, current.text.length, current.sources.length, current.error],
      session.view.active === null,
    ])
    if (signature === painted.answer) return
    painted.answer = signature
    if (item === undefined) {
      const hint = element('div', 'rl-hint')
      hint.append(
        element('span', 'rl-hint-title', session.view.active === null ? 'Sin reunión en curso' : 'Sin preguntas todavía'),
        element(
          'span',
          'rl-hint-note',
          session.view.active === null
            ? 'Cuando recap empiece a grabar, aquí aparecen las preguntas y sus respuestas.'
            : 'Escribe una pregunta abajo o pulsa el atajo. Las que detecte el asistente aparecen solas.',
        ),
      )
      answer.replaceChildren(hint)
      return
    }
    const box = element('div', 'rl-answer-inner')
    const meta = element('div', 'rl-item-meta')
    if (item.origin.ms !== null) meta.append(element('span', 'rl-mono', clockOf(item.origin.ms)))
    if (item.origin.channel !== null && session.view.active?.mode !== 'in-person') {
      meta.append(element('span', '', `preguntó ${channelLabel(item.origin.channel)}`))
    }
    const took = item.streaming !== null || version === undefined ? null : responseTime(version)
    meta.append(element('span', 'spacer'))
    if (took !== null) meta.append(element('span', 'rl-mono', took))
    box.append(meta, element('h2', 'rl-question', item.question.length > 0 ? item.question : 'Buscando la última pregunta…'))
    const content = element('div', 'rl-answer-body')
    let sources: AnswerSource[] = version?.sources ?? []
    if (item.streaming === 'manual' && current !== null) {
      sources = current.sources
      if (current.progress !== null) content.append(progressLine(current.progress))
      else if (current.text.length === 0) content.append(progressLine('Pensando'))
      if (current.text.length > 0) content.append(markdown(current.text, true, copy))
    } else if (item.streaming === 'pending') {
      content.append(progressLine(item.queued ? 'En cola: empieza en cuanto termine otra respuesta' : 'Buscando…'))
    } else {
      if (item.state === 'failed' && current?.error) content.append(problemBox('No pude responder', current.error.message))
      if (version !== undefined && !version.found) content.append(problemBox('No está documentado', ''))
      if (version !== undefined && version.answer.trim().length > 0) content.append(markdown(version.answer, false, copy))
    }
    box.append(content)
    if (sources.length > 0) {
      const rows = element('div', 'rl-sources')
      rows.append(element('span', 'rl-label', 'Fuentes'), ...sources.map(sourceRow))
      box.append(rows)
    }
    if (version !== undefined && item.streaming === null) {
      const row = element('div', 'rl-actions')
      const again = button('rl-action', 'Volver a responder', [icon('rotate', 12), 'Volver a responder'], () => {
        selected = item.key
        session.ask(item.question)
      })
      again.disabled = session.manualStreaming() || session.view.active === null
      row.append(
        button('rl-action', 'Copiar respuesta', [icon('copy', 12), 'Copiar'], () => copy(version.answer)),
        again,
        backlogButton(session.backlogState(version), () => session.toBacklog(version), 'rl-action'),
      )
      box.append(row)
    }
    const scroll = answer.scrollTop
    answer.replaceChildren(box)
    answer.scrollTop = scroll
  }

  function buildFoot(): void {
    const form = document.createElement('form')
    form.className = 'rl-ask'
    const label = element('label', 'visually-hidden', 'Preguntar al asistente')
    label.setAttribute('for', 'rl-question')
    const input = document.createElement('input')
    input.id = 'rl-question'
    input.type = 'text'
    input.placeholder = 'Pregúntale algo de la reunión'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.addEventListener('input', () => {
      draft = input.value
    })
    const send = button('rl-send', 'Preguntar', [icon('send', 13)], () => undefined)
    send.type = 'submit'
    form.append(label, input, send)
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      const question = draft.trim()
      if (question.length === 0) return
      draft = ''
      input.value = ''
      selected = questionKey(question)
      session.ask(question)
    })
    foot.replaceChildren(form, element('div', 'rl-hint-row'))
  }

  function paintFoot(): void {
    const idle = session.view.active === null
    const input = foot.querySelector<HTMLInputElement>('input')
    const send = foot.querySelector<HTMLButtonElement>('.rl-send')
    if (input !== null) input.disabled = idle
    if (send !== null) send.disabled = idle
    const hint = foot.querySelector<HTMLElement>('.rl-hint-row')
    if (hint === null) return
    hint.replaceChildren(element('span', 'live-kbd', shortcutLabel(session.view.shortcut)), element('span', '', 'lo último que se preguntó'))
    if (notice !== null) hint.append(element('span', 'spacer'), element('span', 'rl-notice', notice))
  }

  function transcriptList(): HTMLElement | null {
    return transcript.querySelector<HTMLElement>('.rl-lines')
  }

  function syncFollow(): void {
    const follow = transcript.querySelector<HTMLButtonElement>('.rl-follow')
    if (follow === null) return
    follow.classList.toggle('rl-follow--on', following)
    follow.setAttribute('aria-pressed', String(following))
    follow.replaceChildren(element('span', 'rl-follow-dot'), following ? 'Siguiendo' : 'Seguir')
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
    const row = transcript.querySelector<HTMLElement>(`.rl-line[data-index="${index}"]`)
    const list = transcriptList()
    if (row === null || list === null) return
    following = false
    syncFollow()
    scrolling = true
    list.scrollTo({ top: Math.max(0, row.offsetTop - (list.clientHeight - row.offsetHeight) / 2), behavior: 'smooth' })
    window.setTimeout(() => {
      scrolling = false
    }, 600)
  }

  function buildTranscript(): void {
    const top = element('div', 'rl-label-row')
    const follow = button('rl-follow', 'Seguir la transcripción', [], () => {
      following = !following
      syncFollow()
      if (following) toBottom()
    })
    top.append(element('span', 'rl-label', 'Transcripción en vivo'), element('span', 'spacer'), follow)
    const list = element('div', 'rl-lines')
    list.addEventListener('scroll', () => {
      if (scrolling) return
      const near = list.scrollHeight - list.scrollTop - list.clientHeight < FOLLOW_SLACK_PX
      if (near !== following) {
        following = near
        syncFollow()
      }
    })
    list.addEventListener('click', (event) => {
      const key = (event.target as HTMLElement).closest<HTMLElement>('.rl-line--question')?.dataset['question']
      if (key !== undefined) pick(key)
    })
    const frame = element('div', 'rl-lines-frame')
    frame.append(list, caption)
    transcript.replaceChildren(top, frame)
    syncFollow()
  }

  function lineRow(segment: MeetingSegment, index: number): HTMLElement {
    const row = transcriptLine(segment, false, session.view.active?.mode)
    row.classList.add('rl-line')
    row.dataset['index'] = String(index)
    return row
  }

  function syncCaption(): void {
    const last = lines.at(-1)
    caption.textContent = last?.text ?? ''
    caption.hidden = !captions || last === undefined
  }

  function resetTranscript(): void {
    const list = transcriptList()
    if (list === null) return
    if (lines.length === 0) {
      list.replaceChildren(element('p', 'rl-empty', session.view.active === null ? 'No se está grabando ninguna reunión.' : 'Esperando las primeras frases…'))
    } else {
      list.replaceChildren(...lines.map(lineRow))
    }
    painted.marks = ''
    markTranscript()
    syncCaption()
    if (following) toBottom()
  }

  function markTranscript(): void {
    const current = selectedItem()
    const signature = JSON.stringify([items.map((item) => [item.origin.line, item.key]), current?.origin.line ?? null])
    if (signature === painted.marks) return
    painted.marks = signature
    for (const row of transcript.querySelectorAll<HTMLElement>('.rl-line--question')) {
      row.classList.remove('rl-line--question', 'rl-line--selected')
      delete row.dataset['question']
    }
    for (const item of items) {
      if (item.origin.line === null) continue
      const row = transcript.querySelector<HTMLElement>(`.rl-line[data-index="${item.origin.line}"]`)
      if (row === null) continue
      row.classList.add('rl-line--question')
      if (item.key === current?.key) row.classList.add('rl-line--selected')
      row.dataset['question'] = item.key
    }
  }

  function received(update: LiveTranscriptUpdate): void {
    const list = transcriptList()
    if (update.from === lines.length && list !== null && list.querySelector('.rl-line') !== null) {
      lines = lines.concat(update.lines)
      list.append(...update.lines.map((segment, index) => lineRow(segment, update.from + index)))
      painted.marks = ''
      syncCaption()
      if (following) toBottom()
    } else if (update.from === 0 || update.from === lines.length) {
      lines = update.from === 0 ? update.lines : lines.concat(update.lines)
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
    paintHead()
  }

  function paint(): void {
    items = buildItems()
    choose(items)
    paintHead()
    paintList()
    paintFoot()
    paintAnswer()
    markTranscript()
  }

  function tick(): void {
    const clock = head.querySelector<HTMLElement>('[data-clock="meeting"]')
    if (clock !== null) clock.textContent = subtitle()
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'Escape' && fullscreen && root.isConnected && !root.closest('[hidden]')) void setFullscreen(false)
  }

  buildTranscript()
  buildFoot()

  return {
    root,
    session,
    start() {
      session.listen()
      resetTranscript()
      paint()
      clockTimer = window.setInterval(tick, 1000)
      window.addEventListener('keydown', onKey)
      void session.reload()
      void loadConfig()
    },
    shown() {
      void loadConfig()
    },
    dispose() {
      window.clearInterval(clockTimer)
      window.clearTimeout(noticeTimer)
      window.clearTimeout(confirmTimer)
      window.removeEventListener('keydown', onKey)
      if (fullscreen) void setFullscreen(false)
    },
  }
}
