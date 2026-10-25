import {
  describeProblem,
  type AskPhase,
  openExternal,
  navigate,
  openSourceFile,
  type AnswerSource,
  type LiveAnswer,
  type MeetingSegment,
} from '../bita.ts'
import { pageRoute } from '../shell/links.ts'
import { element, icon } from '../dom.ts'
import { renderMarkdown } from '../notes/markdown.ts'

export const CHANNEL_LABEL: Record<string, string> = { mic: 'Sala', system: 'Remotos' }

export const ERROR_TEXT: Record<string, string> = {
  NOT_RECORDING: 'No se está grabando ninguna reunión.',
  NO_ACTIVE: 'No se está grabando ninguna reunión.',
  ASK_BUSY: 'Ya se está respondiendo otra pregunta. Espera a que termine e inténtalo de nuevo.',
}

export type SourceKind = 'page' | 'file' | 'commit'

export interface SourceActions {
  copy: (text: string) => void
  fail: (message: string) => void
}

export function clockOf(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`
}

export function elapsedLabel(startedAt: string | null | undefined): string {
  if (startedAt === null || startedAt === undefined) return ''
  const since = Date.now() - new Date(startedAt).getTime()
  if (!Number.isFinite(since)) return ''
  const total = Math.max(0, Math.floor(since / 1000))
  const hours = String(Math.floor(total / 3600)).padStart(2, '0')
  const minutes = String(Math.floor((total % 3600) / 60)).padStart(2, '0')
  const seconds = String(total % 60).padStart(2, '0')
  return `${hours}:${minutes}:${seconds}`
}

export function delayLabel(startedAt: string | null | undefined, transcript: MeetingSegment[]): string | null {
  const last = transcript.at(-1)
  if (startedAt === null || startedAt === undefined || last === undefined) return null
  const lag = Math.round((Date.now() - new Date(startedAt).getTime() - last.endMs) / 1000)
  if (!Number.isFinite(lag) || lag < 0) return null
  return `~${lag} s de retraso`
}

export function offsetOf(iso: string | null | undefined, startedAt: string | null | undefined): number | null {
  if (iso === null || iso === undefined || startedAt === null || startedAt === undefined) return null
  const offset = new Date(iso).getTime() - new Date(startedAt).getTime()
  return Number.isFinite(offset) ? offset : null
}

export function askedClock(answer: LiveAnswer, startedAt: string | null | undefined): string {
  const offset = offsetOf(answer.askedAt, startedAt)
  return offset === null ? answer.askedAt.slice(11, 16) : clockOf(offset)
}

export function responseTime(answer: LiveAnswer): string | null {
  if (answer.answeredAt === undefined) return null
  const ms = new Date(answer.answeredAt).getTime() - new Date(answer.askedAt).getTime()
  if (!Number.isFinite(ms) || ms < 0) return null
  const seconds = Math.max(1, Math.round(ms / 1000))
  if (seconds < 60) return `respondida en ${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `respondida en ${minutes} min` : `respondida en ${minutes} min ${rest} s`
}

export function questionKey(question: string): string {
  return question.trim().toLocaleLowerCase('es')
}

export function sameQuestion(left: string, right: string): boolean {
  return questionKey(left) === questionKey(right)
}

export function autoBadge(): HTMLElement {
  const badge = element('span', 'live-auto', 'Detectada')
  badge.title = 'El asistente detectó la pregunta en la conversación'
  return badge
}

export function manualBadge(): HTMLElement {
  const badge = element('span', 'live-auto live-auto--manual', 'Manual')
  badge.title = 'La pediste con el atajo o escribiéndola'
  return badge
}

export function pendingLabel(state: AskPhase): string {
  return state === 'queued' ? 'En cola' : 'Buscando…'
}

export function pendingMark(state: AskPhase, size: number): SVGSVGElement {
  if (state === 'queued') return icon('clock', size)
  const spin = icon('spinner', size)
  spin.classList.add('live-spin')
  return spin
}

export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel
}

export function transcriptLine(segment: MeetingSegment, now: boolean, mode: string | null | undefined): HTMLElement {
  const row = element('div', now ? 'live-line live-line--now' : 'live-line')
  row.append(element('span', 'live-stamp', clockOf(segment.startMs)))
  const text = element('span', 'live-said')
  if (mode !== 'in-person') {
    text.append(element('b', `live-who live-who--${segment.channel}`, channelLabel(segment.channel)), ' ')
  }
  text.append(segment.text)
  row.append(text)
  return row
}

export function sourceKind(source: AnswerSource): SourceKind {
  return source.kind === 'page' || source.kind === 'file' || source.kind === 'commit' ? source.kind : 'file'
}

export function sourceIcon(kind: SourceKind, size: number): SVGSVGElement {
  return icon(kind === 'page' ? 'doc' : kind === 'commit' ? 'commit' : 'code', size)
}

export function sourceAction(source: AnswerSource, actions: SourceActions): { title: string; run: () => void } | null {
  const kind = sourceKind(source)
  if (kind === 'page' && source.pageId !== undefined) {
    const pageId = source.pageId
    return {
      title: 'Abrir la página en Documentación',
      run: () => {
        void navigate(pageRoute(pageId)).catch((error: unknown) => actions.fail(describeProblem(error).message))
      },
    }
  }
  if (kind === 'file' && source.path !== undefined) {
    const path = source.path
    return {
      title: source.line === undefined ? path : `${path}:${source.line}`,
      run: () => {
        void openSourceFile(path).catch((error: unknown) => actions.fail(describeProblem(error).message))
      },
    }
  }
  if (kind === 'commit') {
    const sha = source.sha ?? source.label
    return { title: 'Copiar el commit', run: () => actions.copy(sha) }
  }
  return null
}

export function sourceChip(source: AnswerSource, actions: SourceActions): HTMLElement {
  const kind = sourceKind(source)
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = `live-source live-source--${kind}`
  chip.append(sourceIcon(kind, 11), element('span', '', source.label))
  const action = sourceAction(source, actions)
  if (action === null) {
    chip.disabled = true
  } else {
    chip.title = action.title
    chip.addEventListener('click', action.run)
  }
  return chip
}

export function decorateCode(fragment: DocumentFragment, onCopy: (text: string) => void): void {
  for (const pre of fragment.querySelectorAll<HTMLElement>('pre.md-code')) {
    const text = pre.textContent ?? ''
    const wrap = element('div', 'live-code')
    pre.replaceWith(wrap)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'live-code-copy'
    button.setAttribute('aria-label', 'Copiar comando')
    button.append(icon('copy', 13))
    button.addEventListener('click', () => onCopy(text))
    wrap.append(pre, button)
  }
}

export function markdown(text: string, streaming: boolean, onCopy: (text: string) => void): HTMLElement {
  const body = element('div', 'live-md')
  const fragment = renderMarkdown(text, {
    onCopy,
    onLink: (url) => {
      void openExternal(url).catch(() => undefined)
    },
  })
  decorateCode(fragment, onCopy)
  body.append(fragment)
  if (streaming) {
    const caret = element('span', 'live-caret')
    const last = body.lastElementChild
    if (last !== null && last.tagName === 'P') last.append(caret)
    else body.append(caret)
  }
  return body
}

export interface BacklogState {
  done: boolean
  busy: boolean
}

export function backlogButton(state: BacklogState, onClick: () => void, className = 'live-backlog'): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = state.done ? `${className} ${className}--done` : className
  button.disabled = state.done || state.busy
  button.append(
    icon(state.done ? 'check' : className === 'live-backlog' ? 'inbox' : 'plus', className === 'live-backlog' ? 11 : 13),
    element('span', '', state.done ? 'En el backlog' : state.busy ? 'Guardando…' : 'Al backlog'),
  )
  button.addEventListener('click', onClick)
  return button
}
