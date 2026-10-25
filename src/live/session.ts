import {
  backlogAdd,
  copyText,
  describeProblem,
  liveAsk,
  liveState,
  onLiveAnswer,
  onLiveState,
  onLiveTranscript,
  type AnswerSource,
  type LiveAnswer,
  type LiveAnswerEvent,
  type LiveTranscriptUpdate,
  type LiveView,
  type PendingAsk,
  type StreamEvent,
} from '../bita.ts'
import { ERROR_TEXT, sameQuestion } from './render.ts'

export interface Current {
  askId: number
  startedAt: string
  question: string
  progress: string | null
  text: string
  sources: AnswerSource[]
  done: LiveAnswer | null
  error: { code: string; message: string } | null
}

export interface SessionHooks {
  paint: () => void
  flash: (message: string) => void
  meetingChanged?: () => void
  reloaded?: () => void
  transcript?: (update: LiveTranscriptUpdate) => void
  followLanded?: boolean
}

const LANDED_SLACK_MS = 5000
const OWN_SLACK_MS = 5000

function timeOf(iso: string | null | undefined): number {
  return iso === null || iso === undefined ? Number.NaN : new Date(iso).getTime()
}

export const EMPTY_VIEW: LiveView = {
  active: null,
  title: null,
  entryId: null,
  project: null,
  transcript: [],
  answers: [],
  asking: false,
  pendingAsks: [],
  shortcut: 'Ctrl+Alt+Space',
  visible: true,
  mode: 'compact',
}

export class Session {
  view: LiveView = { ...EMPTY_VIEW }
  current: Current | null = null
  focus: string | null = null
  backlogged = new Set<string>()
  backlogBusy = new Set<string>()
  private seen = new Set<string>()

  private readonly hooks: SessionHooks

  constructor(hooks: SessionHooks) {
    this.hooks = hooks
  }

  manualStreaming(): boolean {
    return this.current !== null && this.current.done === null && this.current.error === null
  }

  resolvedBy(pending: PendingAsk): LiveAnswer | undefined {
    const id = pending.id
    if (id !== null) {
      const byId = this.view.answers.find((answer) => answer.askId === id)
      if (byId !== undefined) return byId
    }
    const question = pending.question
    if (question === null) return undefined
    const started = timeOf(pending.startedAt)
    return this.view.answers.findLast((answer) => {
      if (id !== null && answer.askId !== undefined) return false
      if ((answer.auto === true) !== pending.auto || !sameQuestion(answer.question, question)) return false
      if (!Number.isFinite(started)) return true
      const asked = timeOf(answer.askedAt)
      return !Number.isFinite(asked) || asked >= started - LANDED_SLACK_MS
    })
  }

  ownPending(): PendingAsk | null {
    const current = this.current
    if (current === null || !this.manualStreaming()) return null
    const started = timeOf(current.startedAt)
    const asked = current.question.trim()
    let best: PendingAsk | null = null
    let bestGap = Number.POSITIVE_INFINITY
    for (const pending of this.view.pendingAsks) {
      if (pending.auto) continue
      if (pending.question !== null && asked.length > 0 && !sameQuestion(pending.question, asked)) continue
      const gap = Math.abs(timeOf(pending.startedAt) - started)
      if (!Number.isFinite(gap) || gap > OWN_SLACK_MS || gap >= bestGap) continue
      best = pending
      bestGap = gap
    }
    return best
  }

  pendingAsks(): PendingAsk[] {
    const own = this.ownPending()
    return this.view.pendingAsks.filter(
      (pending) => pending !== own && !(pending.auto && pending.question === null) && this.resolvedBy(pending) === undefined,
    )
  }

  private followLanded(): void {
    const fresh = this.view.answers.filter((answer) => !this.seen.has(answer.id))
    for (const answer of this.view.answers) this.seen.add(answer.id)
    if (this.hooks.followLanded !== true || fresh.length === 0 || this.manualStreaming()) return
    const own = this.current?.done?.id ?? null
    if (fresh.every((answer) => answer.id === own)) return
    this.current = null
    this.focus = null
  }

  copy(text: string): void {
    void copyText(text)
      .then(() => this.hooks.flash('Copiado'))
      .catch(() => this.hooks.flash('No se pudo copiar'))
  }

  start(askId: number, question: string): void {
    this.current = { askId, startedAt: new Date().toISOString(), question, progress: null, text: '', sources: [], done: null, error: null }
    this.focus = null
    this.hooks.paint()
  }

  ask(question: string | null): void {
    void liveAsk(question)
      .then((askId) => {
        if (this.current === null || this.current.askId < askId) this.start(askId, question ?? '')
      })
      .catch((error: unknown) => {
        const problem = describeProblem(error)
        this.current = {
          askId: 0,
          startedAt: new Date().toISOString(),
          question: question ?? '',
          progress: null,
          text: '',
          sources: [],
          done: null,
          error: { code: 'FAILED', message: problem.message },
        }
        this.hooks.paint()
      })
  }

  apply(askId: number, event: StreamEvent): void {
    if (askId === 0) {
      if (event.type === 'error') {
        this.current = {
          askId: 0,
          startedAt: new Date().toISOString(),
          question: '',
          progress: null,
          text: '',
          sources: [],
          done: null,
          error: { code: event.code, message: event.message },
        }
        this.hooks.paint()
      }
      return
    }
    if (this.current === null || this.current.askId < askId) this.start(askId, '')
    const current = this.current
    if (current === null || current.askId !== askId) return
    if (event.type === 'question') current.question = event.text
    if (event.type === 'progress') current.progress = event.text
    if (event.type === 'delta') {
      current.text += event.text
      current.progress = null
    }
    if (event.type === 'source') current.sources = [...current.sources, event.source]
    if (event.type === 'done') {
      current.done = event.answer
      current.question = event.answer.question
      if (!this.view.answers.some((answer) => answer.id === event.answer.id)) {
        this.view.answers = [...this.view.answers, event.answer]
      }
    }
    if (event.type === 'error') {
      if (event.code === 'CANCELLED') return
      current.error = { code: event.code, message: ERROR_TEXT[event.code] ?? event.message }
    }
    this.hooks.paint()
  }

  toBacklog(answer: LiveAnswer): void {
    this.backlogBusy.add(answer.id)
    this.hooks.paint()
    void backlogAdd('pending', answer.question, answer.answer, null, this.view.project)
      .then(() => {
        this.backlogged.add(answer.id)
      })
      .catch((error: unknown) => this.hooks.flash(describeProblem(error).message))
      .finally(() => {
        this.backlogBusy.delete(answer.id)
        this.hooks.paint()
      })
  }

  backlogState(answer: LiveAnswer): { done: boolean; busy: boolean } {
    return { done: this.backlogged.has(answer.id), busy: this.backlogBusy.has(answer.id) }
  }

  async reload(): Promise<boolean> {
    const previous = this.view.active?.meetingId ?? null
    try {
      this.view = await liveState()
    } catch {
      return false
    }
    const changed = (this.view.active?.meetingId ?? null) !== previous
    if (changed) {
      this.current = null
      this.focus = null
      this.backlogged = new Set()
      this.seen = new Set()
      this.hooks.meetingChanged?.()
    }
    this.followLanded()
    this.hooks.paint()
    this.hooks.reloaded?.()
    return changed
  }

  answered({ askId, event }: LiveAnswerEvent): void {
    this.apply(askId, event)
  }

  stateChanged(): void {
    void this.reload()
  }

  transcribed(update: LiveTranscriptUpdate): void {
    if (this.view.active?.meetingId !== update.meetingId) return
    this.view.transcript = update.transcript
    if (this.hooks.transcript === undefined) this.hooks.paint()
    else this.hooks.transcript(update)
  }

  listen(): void {
    onLiveAnswer((answer) => this.answered(answer))
    onLiveState(() => this.stateChanged())
    onLiveTranscript((update) => this.transcribed(update))
  }
}
