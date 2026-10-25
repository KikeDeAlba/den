import { mediaSrc, type MeetingSegment, type MeetingView, type PageMeeting, type Problem } from '../bita.ts'
import { element, icon } from '../dom.ts'
import { human } from '../format.ts'
import { renderMarkdown } from './markdown.ts'
import { formatBytes } from './media-dialogs.ts'
import './room.css'

export type MeetingTab = 'document' | 'minutes' | 'meeting' | 'proposals' | 'answers'

export type MeetingLoad =
  | { state: 'loading' }
  | { state: 'ready'; view: MeetingView }
  | { state: 'missing' }
  | { state: 'failed'; problem: Problem }

export interface MeetingContext {
  info: PageMeeting
  tab: MeetingTab
  load: MeetingLoad
}

export interface MeetingHandlers {
  onTab: (tab: MeetingTab) => void
  onSeek: (seconds: number) => void
  onLink: (url: string) => void
  onCopy: (text: string) => void
}

export interface MinutesCounts {
  agreements: number
  pending: number
  questions: number
}

export interface Marker {
  seconds: number
  kind: 'agreement' | 'pending'
}

export interface Paragraph {
  startMs: number
  endMs: number
  channel: string
  text: string
}

const STAMP = /\[(\d{1,2}):(\d{2}):(\d{2})\]/g
const PARAGRAPH_GAP_MS = 4_000
const PARAGRAPH_SPAN_MS = 30_000
const SPEEDS = [1, 1.25, 1.5, 2]
const CHANNEL_LABEL: Record<string, string> = { mic: 'Sala', system: 'Remotos' }
const WAVE_BARS = 110

export const MEETING_KINDS = ['meeting', 'remote-meeting', 'in-person-meeting']

export function isRemote(info: PageMeeting): boolean {
  return info.kind === 'remote-meeting'
}

export function latestMeeting(meetings: PageMeeting[] | undefined): PageMeeting | null {
  const list = (meetings ?? []).filter((meeting) => MEETING_KINDS.includes(meeting.kind))
  return list.reduce<PageMeeting | null>(
    (latest, meeting) => (latest === null || meeting.startedAt > latest.startedAt ? meeting : latest),
    null,
  )
}

export function hasVideo(view: MeetingView): boolean {
  if (view.mode !== 'remote' || view.recording === null) return false
  if (/\.(m4a|wav|mp3|aac)$/i.test(view.recording)) return false
  return view.hasVideo
}

export function tabsFor(load?: MeetingLoad): MeetingTab[] {
  const tabs: MeetingTab[] = ['document', 'minutes', 'meeting']
  if (load?.state !== 'ready') return tabs
  if ((load.view.proposals ?? []).length > 0) tabs.push('proposals')
  if ((load.view.answers ?? []).length > 0) tabs.push('answers')
  return tabs
}

export const TAB_LABEL: Record<MeetingTab, string> = {
  document: 'Documento',
  minutes: 'Minuta',
  meeting: 'Reunión',
  proposals: 'Cambios propuestos',
  answers: 'Respuestas en vivo',
}

export function meetingWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16)
  const day = date.toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }).replace('.', '')
  const time = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} · ${time}`
}

export function meetingShortDay(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(5, 10)
  return date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }).replace('.', '')
}

function chipWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16)
  const weekday = date.toLocaleDateString('es-MX', { weekday: 'short' }).replace('.', '')
  const day = date.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' }).replace('.', '')
  const time = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${weekday} ${day}, ${time}`
}

export function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} s`
  return human(seconds)
}

export function shortClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = String(total % 60).padStart(2, '0')
  if (hours === 0) return `${String(minutes).padStart(2, '0')}:${rest}`
  return `${hours}:${String(minutes).padStart(2, '0')}:${rest}`
}

export type MeetingFlavor = 'video' | 'audio' | 'in-person'

export function flavorOf(info: PageMeeting, load: MeetingLoad): MeetingFlavor {
  if (!isRemote(info)) return 'in-person'
  if (load.state === 'ready' && !hasVideo(load.view)) return 'audio'
  return 'video'
}

export function meetingChip(info: PageMeeting, load: MeetingLoad): HTMLElement {
  const flavor = flavorOf(info, load)
  const row = element('div', 'meeting-meta')
  const chip = element('span', `room-chip room-chip--${flavor}`)
  const kind = flavor === 'in-person' ? 'Presencial' : flavor === 'audio' ? 'Remota · solo audio' : 'Remota'
  chip.append(
    icon(flavor === 'in-person' ? 'mic' : flavor === 'audio' ? 'wave' : 'screen', 12),
    element('span', '', `${kind} · ${chipWhen(info.startedAt)} · ${durationLabel(info.durationSeconds)}`),
  )
  row.append(chip)
  if (load.state === 'ready') {
    const view = load.view
    if (view.videoRemovedAt !== null && view.videoRemovedAt !== undefined) {
      row.append(element('span', 'kbd', `video borrado el ${meetingShortDay(view.videoRemovedAt)}`))
    } else if (view.video !== null && view.video !== undefined) {
      row.append(element('span', 'kbd', `video comprimido el ${meetingShortDay(view.video.compressedAt)}`))
    }
  }
  return row
}

export function tabBar(context: MeetingContext, onTab: (tab: MeetingTab) => void): HTMLElement {
  const bar = element('div', 'meeting-tabs')
  bar.setAttribute('role', 'tablist')
  bar.setAttribute('aria-label', 'Vistas de la reunión')
  const counts =
    context.load.state === 'ready' && context.load.view.summaryMarkdown !== null
      ? minutesCounts(context.load.view.summaryMarkdown)
      : null
  for (const tab of tabsFor(context.load)) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = tab === context.tab ? 'meeting-tab meeting-tab--on' : 'meeting-tab'
    button.setAttribute('role', 'tab')
    button.setAttribute('aria-selected', String(tab === context.tab))
    button.append(element('span', '', TAB_LABEL[tab]))
    if (tab === 'minutes' && counts !== null) {
      const tally = element('span', 'kbd', `${counts.agreements} · ${counts.pending}`)
      tally.title = `${counts.agreements} acuerdos · ${counts.pending} pendientes`
      button.append(tally)
    }
    if (tab === 'proposals' && context.load.state === 'ready') {
      const open = context.load.view.proposals.filter((proposal) => proposal.status === 'pending').length
      if (open > 0) button.append(element('span', 'meeting-tab-badge', String(open)))
    }
    if (tab === 'answers' && context.load.state === 'ready') {
      button.append(element('span', 'kbd', String(context.load.view.answers.length)))
    }
    button.addEventListener('click', () => onTab(tab))
    bar.append(button)
  }
  return bar
}

function stampSeconds(hours: string, minutes: string, seconds: string): number {
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds)
}

export function minutesBody(markdown: string): string {
  const start = markdown.search(/^##\s+/m)
  return start === -1 ? markdown : markdown.slice(start)
}

export function sectionOf(markdown: string, heading: string): string {
  const lines = markdown.split('\n')
  const wanted = heading.toLowerCase()
  const out: string[] = []
  let inside = false
  for (const line of lines) {
    const match = /^##\s+(.*\S)\s*$/.exec(line)
    if (match?.[1] !== undefined) {
      inside = match[1].toLowerCase().startsWith(wanted)
      continue
    }
    if (inside) out.push(line)
  }
  return out.join('\n')
}

export function minutesCounts(markdown: string): MinutesCounts {
  const agreements = sectionOf(markdown, 'Acuerdos')
    .split('\n')
    .filter((line) => /^\s*\d+[.)]\s+/.test(line)).length
  const pending = sectionOf(markdown, 'Pendientes')
    .split('\n')
    .filter((line) => /^\s*\|/.test(line) && !/^\s*\|\s*[-:]/.test(line))
    .slice(1).length
  const questions = sectionOf(markdown, 'Preguntas abiertas')
    .split('\n')
    .filter((line) => /^\s*[-*]\s+/.test(line) && !/ninguna/i.test(line)).length
  return { agreements, pending, questions }
}

export function minutesMarkers(markdown: string): Marker[] {
  const markers: Marker[] = []
  for (const [heading, kind] of [
    ['Acuerdos', 'agreement'],
    ['Pendientes', 'pending'],
  ] as const) {
    for (const match of sectionOf(markdown, heading).matchAll(STAMP)) {
      markers.push({ seconds: stampSeconds(match[1] ?? '0', match[2] ?? '0', match[3] ?? '0'), kind })
    }
  }
  return markers
}

export function paragraphsOf(segments: MeetingSegment[]): Paragraph[] {
  const result: Paragraph[] = []
  let lastEnd = Number.NEGATIVE_INFINITY
  for (const segment of segments) {
    const last = result.at(-1)
    if (
      last !== undefined &&
      last.channel === segment.channel &&
      segment.startMs - lastEnd <= PARAGRAPH_GAP_MS &&
      segment.startMs - last.startMs < PARAGRAPH_SPAN_MS
    ) {
      last.text = `${last.text} ${segment.text}`
      last.endMs = segment.endMs
    } else {
      result.push({ startMs: segment.startMs, endMs: segment.endMs, channel: segment.channel, text: segment.text })
    }
    lastEnd = Math.max(lastEnd, segment.endMs)
  }
  return result
}

export function activityBars(segments: MeetingSegment[], durationSeconds: number, count: number): number[] {
  const total = Math.max(1, durationSeconds * 1000)
  const bucket = total / count
  const covered = new Array<number>(count).fill(0)
  for (const segment of segments) {
    for (let index = Math.floor(segment.startMs / bucket); index < count && index * bucket < segment.endMs; index += 1) {
      const from = Math.max(segment.startMs, index * bucket)
      const to = Math.min(segment.endMs, (index + 1) * bucket)
      if (to > from) covered[index] = (covered[index] ?? 0) + (to - from)
    }
  }
  return covered.map((value) => Math.min(1, value / bucket))
}

export function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

export function nowIndex(paragraphs: Paragraph[], nowMs: number): number {
  let found = -1
  for (const [index, paragraph] of paragraphs.entries()) {
    if (paragraph.startMs > nowMs) break
    found = index
  }
  if (found === -1) return -1
  const paragraph = paragraphs[found] as Paragraph
  const next = paragraphs[found + 1]
  const limit = next === undefined ? paragraph.endMs + PARAGRAPH_GAP_MS : Math.max(paragraph.endMs + PARAGRAPH_GAP_MS, next.startMs)
  return nowMs < limit ? found : -1
}

export function spokenCut(text: string, startMs: number, endMs: number, nowMs: number): number {
  const span = Math.max(1, endMs - startMs)
  const ratio = Math.min(1, Math.max(0, (nowMs - startMs) / span))
  const target = Math.round(text.length * ratio)
  if (target <= 0) return 0
  if (target >= text.length) return text.length
  const space = text.indexOf(' ', target)
  return space === -1 ? text.length : space
}

let player: { key: string; media: HTMLMediaElement } | null = null
let captionsOn = true
let speedIndex = 0
let currentParagraphs: Paragraph[] = []
let currentFrames: MeetingView['frames'] = []
let following = true
let lastNow = -2
let lastCut = -1
let lastFrame = -2
let transcriptQuery = ''

function mediaKey(view: MeetingView): string {
  return `${view.id}:${view.recording ?? ''}`
}

function mediaFor(view: MeetingView): HTMLMediaElement | null {
  if (view.recording === null) return null
  const key = mediaKey(view)
  if (player?.key === key) return player.media
  releaseMedia()
  const media = document.createElement(hasVideo(view) ? 'video' : 'audio')
  media.className = 'meeting-media'
  media.preload = 'metadata'
  media.src = mediaSrc(view.recording)
  media.playbackRate = SPEEDS[speedIndex] ?? 1
  for (const event of ['timeupdate', 'play', 'pause', 'loadedmetadata', 'ratechange', 'seeked']) {
    media.addEventListener(event, () => refreshPlayer(media))
  }
  player = { key, media }
  return media
}

export function releaseMedia(): void {
  if (player === null) return
  const media = player.media
  player = null
  media.pause()
  media.removeAttribute('src')
  media.load()
  media.remove()
}

export function currentSeconds(): number {
  return player?.media.currentTime ?? 0
}

export function seekTo(view: MeetingView, seconds: number): void {
  const media = mediaFor(view)
  if (media === null) return
  setFollowing(true)
  const go = () => {
    media.currentTime = seconds
    void media.play().catch(() => undefined)
  }
  if (media.readyState >= 1) go()
  else media.addEventListener('loadedmetadata', go, { once: true })
}

export function stopPlayback(): void {
  player?.media.pause()
}

function lengthOf(media: HTMLMediaElement, view: MeetingView): number {
  return Number.isFinite(media.duration) && media.duration > 0 ? media.duration : (view.durationSeconds ?? 0)
}

function frameIndex(seconds: number): number {
  let found = -1
  for (const [index, frame] of currentFrames.entries()) {
    if (frame.timeSeconds > seconds + 0.5) break
    found = index
  }
  return found
}

export function frameAt(view: MeetingView, seconds: number): string | null {
  let found: string | null = view.frames[0]?.src ?? null
  for (const frame of view.frames) {
    if (frame.timeSeconds > seconds + 0.5) break
    found = frame.src
  }
  return found
}

export function currentFrameSrc(view: MeetingView): string | null {
  return frameAt(view, player?.media.currentTime ?? 0)
}

function refreshPlayer(media: HTMLMediaElement): void {
  const total = Number.isFinite(media.duration) && media.duration > 0 ? media.duration : 0
  const ratio = total > 0 ? media.currentTime / total : 0
  for (const fill of document.querySelectorAll<HTMLElement>('.mp-fill')) fill.style.width = `${(ratio * 100).toFixed(2)}%`
  for (const head of document.querySelectorAll<HTMLElement>('.mp-head')) head.style.left = `${(ratio * 100).toFixed(2)}%`
  for (const label of document.querySelectorAll<HTMLElement>('.mp-time')) {
    label.textContent = `${shortClock(media.currentTime)} / ${shortClock(total)}`
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('.mp-play')) {
    button.replaceChildren(icon(media.paused ? 'play' : 'pause', 12))
    button.setAttribute('aria-label', media.paused ? 'Reproducir' : 'Pausar')
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>('.mp-speed')) {
    button.textContent = `${media.playbackRate}×`
  }
  for (const bar of document.querySelectorAll<HTMLElement>('.mp-bar')) {
    bar.classList.toggle('mp-bar--played', Number(bar.dataset['at'] ?? '1') <= ratio)
  }
  const nowMs = media.currentTime * 1000
  const at = nowIndex(currentParagraphs, nowMs)
  const now = at === -1 ? undefined : currentParagraphs[at]
  for (const caption of document.querySelectorAll<HTMLElement>('.mp-caption')) {
    caption.textContent = now?.text ?? ''
    caption.hidden = !captionsOn || now === undefined
  }
  for (const pill of document.querySelectorAll<HTMLElement>('.room-back-time')) {
    pill.textContent = shortClock(media.currentTime)
  }
  refreshFrames(media.currentTime)
  refreshTranscript(at, nowMs)
}

function refreshFrames(seconds: number): void {
  const at = frameIndex(seconds)
  if (at === lastFrame && document.querySelector('.room-frame--now') !== null) return
  lastFrame = at
  for (const [index, button] of [...document.querySelectorAll<HTMLElement>('.room-frame')].entries()) {
    const on = index === at
    button.classList.toggle('room-frame--now', on)
    button.setAttribute('aria-current', String(on))
    if (on) {
      const strip = button.parentElement
      if (strip !== null) {
        const left = button.offsetLeft - strip.offsetLeft
        if (left < strip.scrollLeft || left + button.offsetWidth > strip.scrollLeft + strip.clientWidth) {
          strip.scrollTo({ left: Math.max(0, left - strip.clientWidth / 2 + button.offsetWidth / 2), behavior: 'smooth' })
        }
      }
    }
  }
  const frame = currentFrames[Math.max(0, at)]
  for (const slide of document.querySelectorAll<HTMLImageElement>('.room-slide-image')) {
    if (frame !== undefined && slide.getAttribute('src') !== frame.src) slide.src = frame.src
  }
  for (const label of document.querySelectorAll<HTMLElement>('.room-slide-time')) {
    label.textContent = frame === undefined ? 'Sin capturas' : `Captura de ${shortClock(frame.timeSeconds)} · cambia sola con el audio`
  }
}

function refreshTranscript(at: number, nowMs: number): void {
  const list = document.querySelector<HTMLElement>('.room-list')
  if (list === null) return
  const rows = [...list.querySelectorAll<HTMLElement>('.room-row')]
  const changed = at !== lastNow
  if (changed) {
    lastNow = at
    lastCut = -1
    rows.forEach((row, index) => {
      row.classList.toggle('room-row--past', at !== -1 && index < at)
      const on = index === at
      if (row.classList.contains('room-row--now') && !on) restoreText(row)
      row.classList.toggle('room-row--now', on)
    })
  }
  const row = at === -1 ? undefined : rows[at]
  const paragraph = at === -1 ? undefined : currentParagraphs[at]
  if (row !== undefined && paragraph !== undefined && transcriptQuery.length === 0) {
    const cut = spokenCut(paragraph.text, paragraph.startMs, paragraph.endMs, nowMs)
    if (cut !== lastCut) {
      lastCut = cut
      const text = row.querySelector<HTMLElement>('.room-text')
      text?.replaceChildren(
        element('span', 'room-said', paragraph.text.slice(0, cut)),
        element('span', 'room-tosay', paragraph.text.slice(cut)),
      )
    }
  }
  if (changed && following && row !== undefined && !row.hidden) centerRow(list, row)
}

function centerRow(list: HTMLElement, row: HTMLElement): void {
  const top = row.offsetTop - list.clientHeight / 2 + row.offsetHeight / 2
  list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
}

function restoreText(row: HTMLElement): void {
  const text = row.querySelector<HTMLElement>('.room-text')
  const original = currentParagraphs.find((item) => String(item.startMs) === row.dataset['start'])
  if (text !== null && original !== undefined) highlight(text, original.text, transcriptQuery)
}

function paintFollow(chip: HTMLElement): void {
  chip.classList.toggle('room-follow--paused', !following)
  chip.replaceChildren(icon(following ? 'follow' : 'pause', 11), element('span', '', following ? 'Siguiendo' : 'Seguimiento en pausa'))
}

function setFollowing(on: boolean): void {
  following = on
  for (const chip of document.querySelectorAll<HTMLElement>('.room-follow')) paintFollow(chip)
  for (const pill of document.querySelectorAll<HTMLElement>('.room-back')) pill.hidden = on
  if (on) {
    const list = document.querySelector<HTMLElement>('.room-list')
    const row = list?.querySelector<HTMLElement>('.room-row--now')
    if (list && row) centerRow(list, row)
  }
}

function progress(view: MeetingView, media: HTMLMediaElement, markers: Marker[], frames: boolean, bars: number[] | null): HTMLElement {
  const track = element('div', bars === null ? 'mp-track' : 'mp-track mp-track--wave')
  track.setAttribute('role', 'slider')
  track.setAttribute('aria-label', 'Posición en la grabación')
  track.tabIndex = 0
  if (bars !== null) {
    const wave = element('div', 'mp-wave')
    bars.forEach((height, index) => {
      const bar = element('span', 'mp-bar')
      bar.dataset['at'] = String(index / bars.length)
      bar.style.height = `${Math.round(14 + height * 86)}%`
      wave.append(bar)
    })
    track.append(wave)
  } else {
    const rail = element('div', 'mp-rail')
    rail.append(element('div', 'mp-fill'))
    track.append(rail, element('div', 'mp-head'))
  }
  const total = lengthOf(media, view)
  if (total > 0) {
    for (const marker of markers) {
      const dot = element('span', marker.kind === 'agreement' ? 'mp-marker mp-marker--agreement' : 'mp-marker mp-marker--pending')
      dot.style.left = `${Math.min(100, (marker.seconds / total) * 100)}%`
      dot.title = `${marker.kind === 'agreement' ? 'Acuerdo' : 'Pendiente'} ${shortClock(marker.seconds)}`
      track.append(dot)
    }
    if (frames) {
      for (const frame of view.frames) {
        const box = element('span', 'mp-marker mp-marker--frame')
        box.style.left = `${Math.min(100, (frame.timeSeconds / total) * 100)}%`
        box.title = `Captura ${shortClock(frame.timeSeconds)}`
        track.append(box)
      }
    }
  }
  const jump = (clientX: number) => {
    const rect = track.getBoundingClientRect()
    const length = lengthOf(media, view)
    if (rect.width === 0 || length === 0) return
    setFollowing(true)
    media.currentTime = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * length
  }
  track.addEventListener('click', (event) => jump(event.clientX))
  track.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight') media.currentTime = Math.min(lengthOf(media, view), media.currentTime + 5)
    if (event.key === 'ArrowLeft') media.currentTime = Math.max(0, media.currentTime - 5)
  })
  return track
}

function controlButton(className: string, label: string, child: Node, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = className
  button.setAttribute('aria-label', label)
  button.append(child)
  button.addEventListener('click', onClick)
  return button
}

function legend(withFrames: boolean): HTMLElement {
  const row = element('div', 'mp-legend')
  row.append(element('span', 'mp-key mp-key--agreement', 'acuerdo'), element('span', 'mp-key mp-key--pending', 'pendiente'))
  if (withFrames) row.append(element('span', 'mp-key mp-key--frame', 'captura'))
  return row
}

function togglePlay(media: HTMLMediaElement): void {
  if (media.paused) void media.play().catch(() => undefined)
  else media.pause()
}

function speedButton(media: HTMLMediaElement): HTMLButtonElement {
  const speed = document.createElement('button')
  speed.type = 'button'
  speed.className = 'mp-speed'
  speed.setAttribute('aria-label', 'Velocidad')
  speed.textContent = `${media.playbackRate}×`
  speed.addEventListener('click', () => {
    speedIndex = (speedIndex + 1) % SPEEDS.length
    media.playbackRate = SPEEDS[speedIndex] ?? 1
  })
  return speed
}

function videoControls(media: HTMLMediaElement, stage: HTMLElement): HTMLElement {
  const row = element('div', 'mp-controls')
  const captions = controlButton('mp-icon', 'Subtítulos', icon('captions', 15), () => {
    captionsOn = !captionsOn
    captions.setAttribute('aria-pressed', String(captionsOn))
    refreshPlayer(media)
  })
  captions.setAttribute('aria-pressed', String(captionsOn))
  row.append(
    controlButton('mp-play', 'Reproducir', icon('play', 12), () => togglePlay(media)),
    controlButton('mp-icon', 'Retroceder 10 segundos', icon('rewind', 15), () => {
      media.currentTime = Math.max(0, media.currentTime - 10)
    }),
    element('span', 'mp-time', '00:00 / 00:00'),
    element('span', 'spacer'),
    legend(true),
    speedButton(media),
    captions,
    controlButton('mp-icon', 'Pantalla completa', icon('fullscreen', 14), () => {
      void stage.requestFullscreen().catch(() => undefined)
    }),
  )
  return row
}

function stateNote(load: MeetingLoad): HTMLElement | null {
  if (load.state === 'loading') return element('p', 'placeholder', 'Leyendo la reunión…')
  if (load.state === 'missing') {
    const box = element('div', 'no-doc')
    box.append(element('span', 'no-doc-title', 'La grabación ya no está en este equipo'))
    box.append(element('p', 'no-doc-note', 'La página salió de una reunión, pero recap no tiene su carpeta.'))
    return box
  }
  if (load.state === 'failed') {
    const box = element('div', 'problem')
    box.append(element('div', 'problem-message', load.problem.message))
    if (load.problem.hint) box.append(element('div', 'problem-hint', load.problem.hint))
    return box
  }
  return null
}

function linkStamps(root: Node, onSeek: (seconds: number) => void): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)
  for (const text of texts) {
    const value = text.nodeValue ?? ''
    if (!STAMP.test(value)) continue
    STAMP.lastIndex = 0
    const fragment = document.createDocumentFragment()
    let at = 0
    for (const match of value.matchAll(STAMP)) {
      const index = match.index ?? 0
      fragment.append(document.createTextNode(value.slice(at, index)))
      const seconds = stampSeconds(match[1] ?? '0', match[2] ?? '0', match[3] ?? '0')
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'stamp'
      button.textContent = shortClock(seconds)
      button.addEventListener('click', () => onSeek(seconds))
      fragment.append(button)
      at = index + match[0].length
    }
    fragment.append(document.createTextNode(value.slice(at)))
    text.replaceWith(fragment)
  }
}

export function renderMinutes(context: MeetingContext, handlers: MeetingHandlers, highlightQuery = ''): HTMLElement {
  const wrap = element('div', 'doc-body')
  const article = element('article', 'article meeting-article')
  const note = stateNote(context.load)
  if (note !== null || context.load.state !== 'ready') {
    if (note !== null) article.append(note)
    wrap.append(article)
    return wrap
  }
  const markdown = context.load.view.summaryMarkdown
  if (markdown === null) {
    article.append(element('p', 'doc-section-blank', 'Esta reunión todavía no tiene minuta.'))
    wrap.append(article)
    return wrap
  }
  const rendered = renderMarkdown(minutesBody(markdown), {
    onLink: handlers.onLink,
    onCopy: handlers.onCopy,
    ...(highlightQuery.length > 0 ? { highlight: highlightQuery } : {}),
  })
  linkStamps(rendered, handlers.onSeek)
  article.append(rendered)
  wrap.append(article)
  return wrap
}

function highlight(paragraph: HTMLElement, text: string, query: string): void {
  paragraph.replaceChildren()
  if (query.length === 0) {
    paragraph.textContent = text
    return
  }
  const folded = fold(text)
  let at = 0
  let found = folded.indexOf(query)
  while (found !== -1) {
    paragraph.append(document.createTextNode(text.slice(at, found)))
    paragraph.append(element('mark', 'hit', text.slice(found, found + query.length)))
    at = found + query.length
    found = folded.indexOf(query, at)
  }
  paragraph.append(document.createTextNode(text.slice(at)))
}

function transcriptRows(remote: boolean, handlers: MeetingHandlers): HTMLElement[] {
  return currentParagraphs.map((paragraph) => {
    const row = element('div', `room-row room-row--${paragraph.channel}`)
    row.dataset['start'] = String(paragraph.startMs)
    row.dataset['channel'] = paragraph.channel
    row.dataset['text'] = fold(paragraph.text)
    const stamp = document.createElement('button')
    stamp.type = 'button'
    stamp.className = 'room-stamp'
    stamp.textContent = shortClock(paragraph.startMs / 1000)
    stamp.setAttribute('aria-label', `Ir a ${shortClock(paragraph.startMs / 1000)}`)
    stamp.addEventListener('click', () => {
      setFollowing(true)
      handlers.onSeek(paragraph.startMs / 1000)
    })
    const body = element('div', 'room-row-body')
    if (remote) {
      body.append(element('span', `room-who room-who--${paragraph.channel}`, CHANNEL_LABEL[paragraph.channel] ?? paragraph.channel))
    }
    const text = element('p', 'room-text')
    highlight(text, paragraph.text, transcriptQuery)
    body.append(text)
    row.append(stamp, body)
    return row
  })
}

function filterRows(list: HTMLElement, channel: string, counter: HTMLElement): void {
  let matches = 0
  for (const row of list.querySelectorAll<HTMLElement>('.room-row')) {
    const textMatch = transcriptQuery.length === 0 || (row.dataset['text'] ?? '').includes(transcriptQuery)
    const channelMatch = channel === 'all' || row.dataset['channel'] === channel
    row.hidden = !(textMatch && channelMatch)
    restoreText(row)
    if (!row.hidden && transcriptQuery.length > 0) matches += 1
  }
  lastCut = -1
  counter.textContent = transcriptQuery.length === 0 ? '' : `${matches} ${matches === 1 ? 'coincidencia' : 'coincidencias'}`
}

function transcriptColumn(remote: boolean, handlers: MeetingHandlers, initialQuery: string): HTMLElement {
  const column = element('section', 'room-transcript')
  column.setAttribute('aria-label', 'Transcripción')
  const tools = element('div', 'room-tools')
  const follow = document.createElement('button')
  follow.type = 'button'
  follow.className = 'room-follow'
  follow.title = 'La transcripción sigue al audio; desplázate para pausar'
  follow.addEventListener('click', () => setFollowing(!following))
  paintFollow(follow)
  tools.append(follow)

  const list = element('div', 'room-list')
  list.tabIndex = 0
  list.setAttribute('aria-label', 'Párrafos de la transcripción')
  const counter = element('span', 'kbd room-count')
  let channel = 'all'

  if (remote) {
    const group = element('div', 'room-channels')
    group.setAttribute('role', 'group')
    group.setAttribute('aria-label', 'Canal')
    for (const [value, label] of [
      ['all', 'Todos'],
      ['mic', 'Sala'],
      ['system', 'Remotos'],
    ] as const) {
      const button = document.createElement('button')
      button.type = 'button'
      button.className = 'room-chip-filter'
      button.textContent = label
      button.setAttribute('aria-pressed', String(value === channel))
      button.addEventListener('click', () => {
        channel = value
        for (const other of group.querySelectorAll('button')) other.setAttribute('aria-pressed', String(other === button))
        filterRows(list, channel, counter)
      })
      group.append(button)
    }
    tools.append(group)
  }

  tools.append(element('span', 'spacer'), counter)
  const copyAll = controlButton('room-copy', 'Copiar la transcripción', icon('copy', 13), () => {
    handlers.onCopy(
      currentParagraphs
        .map((paragraph) => `[${shortClock(paragraph.startMs / 1000)}] ${remote ? `${CHANNEL_LABEL[paragraph.channel] ?? paragraph.channel}: ` : ''}${paragraph.text}`)
        .join('\n'),
    )
  })
  tools.append(copyAll)

  const field = element('label', 'room-search')
  const glass = element('span', 'search-glass')
  glass.append(icon('search', 13))
  const input = document.createElement('input')
  input.type = 'search'
  input.placeholder = 'Buscar en la transcripción'
  input.setAttribute('aria-label', 'Buscar en la transcripción')
  input.autocomplete = 'off'
  input.spellcheck = false
  input.value = initialQuery
  field.append(glass, input)
  tools.append(field)
  input.addEventListener('input', () => {
    transcriptQuery = fold(input.value.trim())
    filterRows(list, channel, counter)
  })

  if (currentParagraphs.length === 0) {
    list.append(element('p', 'doc-section-blank', 'No se detectó voz en la grabación.'))
  } else {
    list.append(...transcriptRows(remote, handlers))
  }
  const pause = () => {
    if (following) setFollowing(false)
  }
  list.addEventListener('wheel', pause, { passive: true })
  list.addEventListener('touchmove', pause, { passive: true })
  list.addEventListener('keydown', (event) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) pause()
  })

  const frame = element('div', 'room-list-frame')
  const back = document.createElement('button')
  back.type = 'button'
  back.className = 'room-back'
  back.hidden = following
  back.append(icon('follow', 12), element('span', '', 'Volver al momento actual · '), element('span', 'room-back-time', '00:00'))
  back.addEventListener('click', () => setFollowing(true))
  frame.append(list, element('div', 'room-fade room-fade--top'), element('div', 'room-fade room-fade--bottom'), back)
  column.append(tools, frame)
  if (initialQuery.length > 0) filterRows(list, channel, counter)
  return column
}

function framesStrip(view: MeetingView, media: HTMLMediaElement, large: boolean): HTMLElement {
  const strip = element('div', large ? 'room-frames' : 'room-frames room-frames--small')
  for (const frame of view.frames) {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'room-frame'
    button.setAttribute('aria-label', `Ir a ${shortClock(frame.timeSeconds)}`)
    const thumb = element('span', 'room-frame-thumb')
    const image = document.createElement('img')
    image.src = frame.src
    image.alt = ''
    image.loading = 'lazy'
    thumb.append(image)
    button.append(thumb, element('span', 'room-frame-time', shortClock(frame.timeSeconds)))
    button.addEventListener('click', () => {
      setFollowing(true)
      media.currentTime = frame.timeSeconds
      void media.play().catch(() => undefined)
    })
    strip.append(button)
  }
  return strip
}

function audioPlayer(view: MeetingView, media: HTMLMediaElement, markers: Marker[], note: string, compact: boolean): HTMLElement {
  const card = element('div', compact ? 'room-player room-player--inline' : 'room-player')
  const top = element('div', 'room-player-top')
  top.append(
    controlButton('mp-play room-pbtn', 'Reproducir', icon('play', 12), () => togglePlay(media)),
    progress(view, media, markers, false, activityBars(view.segments, view.durationSeconds ?? 0, WAVE_BARS)),
  )
  const bottom = element('div', 'room-player-bottom')
  bottom.append(
    element('span', 'mp-time', '00:00 / 00:00'),
    legend(false),
    element('span', 'spacer'),
    element('span', 'kbd', note),
    controlButton('mp-icon', 'Retroceder 10 segundos', icon('rewind', 15), () => {
      media.currentTime = Math.max(0, media.currentTime - 10)
    }),
    speedButton(media),
  )
  card.append(media, top, bottom)
  return card
}

export function renderRoom(context: MeetingContext, handlers: MeetingHandlers, initialQuery = ''): HTMLElement {
  const note = stateNote(context.load)
  if (note !== null || context.load.state !== 'ready') {
    const wrap = element('div', 'doc-body')
    const article = element('article', 'article meeting-article')
    if (note !== null) article.append(note)
    wrap.append(article)
    return wrap
  }
  const view = context.load.view
  const remote = isRemote(context.info)
  currentParagraphs = paragraphsOf(view.segments)
  currentFrames = view.frames
  transcriptQuery = fold(initialQuery.trim())
  lastNow = -2
  lastCut = -1
  lastFrame = -2
  const media = mediaFor(view)
  const markers = view.summaryMarkdown === null ? [] : minutesMarkers(view.summaryMarkdown)
  const flavor = flavorOf(context.info, context.load)
  const room = element('div', `room room--${flavor}`)

  if (media === null) {
    const wrap = element('div', 'room-stack')
    wrap.append(element('p', 'doc-section-blank', 'Esta reunión no tiene grabación en este equipo.'))
    wrap.append(transcriptColumn(remote, handlers, initialQuery))
    room.append(wrap)
    return room
  }

  if (flavor === 'video') {
    const side = element('section', 'room-media')
    side.setAttribute('aria-label', 'Video')
    const stage = element('div', 'mv-stage room-stage')
    stage.append(media)
    const overlay = element('div', 'mv-overlay')
    const caption = element('p', 'mp-caption')
    caption.hidden = true
    overlay.append(caption, progress(view, media, markers, true, null), videoControls(media, stage))
    stage.append(overlay)
    media.onclick = () => togglePlay(media)
    side.append(stage)
    const head = element('div', 'room-frames-head')
    head.append(element('h2', '', 'Capturas clave'), element('span', 'kbd', 'la actual se marca sola mientras avanza'))
    side.append(head)
    side.append(view.frames.length === 0 ? element('p', 'kbd', 'Esta reunión no tiene capturas.') : framesStrip(view, media, true))
    room.append(side, transcriptColumn(true, handlers, initialQuery))
  } else if (flavor === 'audio') {
    const side = element('section', 'room-media')
    side.setAttribute('aria-label', 'Audio y capturas')
    const slide = element('div', 'room-slide')
    const first = frameAt(view, 0)
    if (first !== null) {
      const image = document.createElement('img')
      image.className = 'room-slide-image'
      image.src = first
      image.alt = 'Captura de pantalla del momento actual'
      slide.append(image)
    } else {
      slide.append(element('p', 'room-slide-empty', 'Esta reunión no tiene capturas.'))
    }
    const badge = element('span', 'room-slide-time', 'Captura')
    const caption = element('p', 'mp-caption')
    caption.hidden = true
    slide.append(badge, caption)
    const audio = view.storage === null ? 'Sala + Remotos' : `Sala + Remotos · ${sizeLabel(view.storage.recordingBytes)}`
    side.append(slide, audioPlayer(view, media, markers, audio, false))
    if (view.frames.length > 0) side.append(framesStrip(view, media, false))
    room.append(side, transcriptColumn(true, handlers, initialQuery))
  } else {
    const stack = element('div', 'room-stack')
    stack.append(audioPlayer(view, media, markers, 'micrófono', true), transcriptColumn(false, handlers, initialQuery))
    room.append(stack)
  }

  setFollowing(following)
  queueMicrotask(() => refreshPlayer(media))
  return room
}

function sizeLabel(bytes: number): string {
  return formatBytes(bytes)
}
