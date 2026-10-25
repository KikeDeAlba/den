import {
  copyText,
  describeProblem,
  mediaSrc,
  meetingById,
  meetingDownload,
  meetingSummary,
  meetingTranscript,
  openExternal,
  type MeetingSummary,
  type MeetingTranscript,
  type MeetingView,
} from '../../bita.ts'
import { element, icon } from '../../dom.ts'
import { pendientesRoute } from '../../shell/links.ts'
import { go } from '../../shell/routes.ts'
import { renderMarkdown } from '../../notes/markdown.ts'
import { hasVideo, renderMinutes, shortClock } from '../../notes/meeting.ts'
import {
  docPath,
  docRoute,
  linesFromRecap,
  linesFromSegments,
  mediaText,
  meetingRoute,
  pageMeetingOf,
  summaryText,
  type MeetingRow,
  type PastTab,
  type TranscriptLine,
} from './model.ts'

export interface PastOptions {
  row: MeetingRow
  tab: PastTab
  summaryJson: boolean
  transcriptJson: boolean
}

export interface PastView {
  root: HTMLElement
  tab: (tab: PastTab) => void
  dispose: () => void
}

interface Loaded {
  view: MeetingView | null
  summary: MeetingSummary | null
  transcript: MeetingTranscript | null
  problem: string | null
}

const TAB_LABEL: Record<PastTab, string> = { minuta: 'Minuta', transcripcion: 'Transcripción', grabacion: 'Grabación' }

function when(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16)
  const day = date.toLocaleDateString('es-MX', { weekday: 'short', day: 'numeric', month: 'short' }).replace(/\./g, '')
  const time = date.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${day} ${time}`
}

function label(text: string): HTMLElement {
  return element('span', 'rp-label', text)
}

async function settle<T>(run: boolean, load: () => Promise<T>): Promise<T | null> {
  if (!run) return null
  try {
    return await load()
  } catch {
    return null
  }
}

async function loadMeeting(id: string, summaryJson: boolean, transcriptJson: boolean): Promise<Loaded> {
  const [view, summary, transcript] = await Promise.all([
    meetingById(id).catch((error: unknown) => describeProblem(error)),
    settle(summaryJson, () => meetingSummary(id)),
    settle(transcriptJson, () => meetingTranscript(id)),
  ])
  if (view !== null && 'kind' in view) return { view: null, summary, transcript, problem: view.message }
  return { view, summary, transcript, problem: null }
}

export function createPastView(options: PastOptions): PastView {
  const { row } = options
  const root = element('section', 'rp')
  root.setAttribute('aria-label', row.title)
  const head = element('header', 'rp-head')
  const tabs = element('div', 'rp-tabs')
  tabs.setAttribute('role', 'tablist')
  const body = element('div', 'rp-body')
  root.append(head, tabs, body)

  let tab = options.tab
  let loaded: Loaded | null = null
  let media: HTMLMediaElement | null = null
  let captions = true
  let pendingSeek: number | null = null
  let lines: TranscriptLine[] = []
  let disposed = false

  const detail = [when(row.startedAt), shortClock(row.durationSeconds), row.project, mediaText(row.mode, row.hasVideo)].join(' · ')

  function status(text: string): void {
    const note = head.querySelector<HTMLElement>('.rp-status')
    if (note !== null) note.textContent = text
  }

  function paintHead(): void {
    const view = loaded?.view ?? null
    const watch = document.createElement('button')
    watch.type = 'button'
    watch.className = 'rp-watch'
    watch.append(icon('play', 11), 'Ver la grabación')
    watch.disabled = view !== null && view.recording === null
    watch.addEventListener('click', () => go(meetingRoute(row.id, 'grabacion')))
    const download = document.createElement('button')
    download.type = 'button'
    download.className = 'rl-icon'
    download.setAttribute('aria-label', 'Descargar la grabación')
    download.title = 'Descargar la grabación'
    download.append(icon('download', 14))
    download.disabled = view === null || view.recording === null
    download.addEventListener('click', () => {
      if (view === null || view.recording === null) return
      download.disabled = true
      status('Copiando a Descargas…')
      void meetingDownload(view.dir, view.recording, row.title)
        .then((path) => status(`Guardada en ${path}`))
        .catch((error: unknown) => status(describeProblem(error).message))
        .finally(() => {
          download.disabled = false
        })
    })
    head.replaceChildren(
      element('h1', 'rp-title', row.title),
      element('span', 'rp-detail', detail),
      element('span', 'spacer'),
      watch,
      download,
      element('span', 'rp-status'),
    )
  }

  function paintTabs(): void {
    tabs.replaceChildren(
      ...(['minuta', 'transcripcion'] as const).map((id) => {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = id === tab ? 'rp-tab rp-tab--on' : 'rp-tab'
        button.setAttribute('role', 'tab')
        button.setAttribute('aria-selected', String(id === tab))
        button.textContent = TAB_LABEL[id]
        button.addEventListener('click', () => go(meetingRoute(row.id, id)))
        return button
      }),
    )
    if (tab === 'grabacion') {
      const on = element('span', 'rp-tab rp-tab--on', TAB_LABEL.grabacion)
      on.setAttribute('aria-current', 'true')
      tabs.append(on)
    }
  }

  function seek(seconds: number): void {
    pendingSeek = seconds
    if (tab !== 'grabacion') {
      go(meetingRoute(row.id, 'grabacion'))
      return
    }
    applySeek()
  }

  function applySeek(): void {
    const target = media
    const seconds = pendingSeek
    if (target === null || seconds === null) return
    pendingSeek = null
    const run = (): void => {
      target.currentTime = seconds
      void target.play().catch(() => undefined)
    }
    if (target.readyState >= 1) run()
    else target.addEventListener('loadedmetadata', run, { once: true })
  }

  function docLink(): HTMLElement | null {
    const place = row.place
    if (place === null) return null
    const line = element('p', 'rp-doc')
    const link = document.createElement('button')
    link.type = 'button'
    link.className = 'quiet-link'
    link.textContent = docPath(place)
    link.addEventListener('click', () => go(docRoute(place)))
    line.append('La minuta también vive en ', link)
    return line
  }

  function minuta(): HTMLElement {
    const box = element('div', 'rp-minuta')
    const summary = loaded?.summary ?? null
    const view = loaded?.view ?? null
    if (summary !== null) {
      const resumen = element('div', 'rp-block')
      const text = summaryText(summary)
      const prose = element('div', 'rp-prose')
      if (text.length > 0) prose.append(renderMarkdown(text, { onLink: (url) => void openExternal(url).catch(() => undefined) }))
      else prose.append(element('p', 'rp-empty', 'La minuta no trae resumen.'))
      resumen.append(label('Resumen'), prose)
      const acuerdos = element('div', 'rp-block')
      acuerdos.append(label('Acuerdos'))
      if (summary.agreements.length === 0) acuerdos.append(element('p', 'rp-empty', 'No se registraron acuerdos.'))
      const list = element('ul', 'rp-agreements')
      for (const agreement of summary.agreements) list.append(element('li', '', agreement))
      if (summary.agreements.length > 0) acuerdos.append(list)
      const pendientes = element('div', 'rp-block')
      pendientes.append(label('Pendientes que salieron'))
      if (summary.actionItems.length === 0) pendientes.append(element('p', 'rp-empty', 'No salió ningún pendiente.'))
      for (const item of summary.actionItems) {
        const button = document.createElement('button')
        button.type = 'button'
        button.className = 'rp-item'
        button.append(
          element('span', 'rp-item-key', item.backlogKey ?? '—'),
          element('span', 'rp-item-text', item.text),
          element('span', 'rp-item-state', item.backlogKey === null ? 'sin anotar' : 'en pendientes'),
        )
        button.addEventListener('click', () => go(pendientesRoute(row.place?.projectSlug ?? null, item.backlogKey)))
        pendientes.append(button)
      }
      box.append(resumen, acuerdos, pendientes)
    } else if (view !== null) {
      box.append(
        renderMinutes(
          { info: pageMeetingOf(row), tab: 'minutes', load: { state: 'ready', view } },
          {
            onTab: () => undefined,
            onSeek: seek,
            onLink: (url) => void openExternal(url).catch(() => undefined),
            onCopy: (text) => void copyText(text).catch(() => undefined),
          },
        ),
      )
    }
    const link = docLink()
    if (link !== null) box.append(link)
    return box
  }

  function transcriptList(withStamps: boolean): HTMLElement {
    const list = element('div', 'rp-lines')
    if (lines.length === 0) list.append(element('p', 'rp-empty', 'Esta reunión no tiene transcripción.'))
    lines.forEach((line, index) => {
      const item = element('div', `rp-line rp-line--${line.channel}`)
      item.dataset['index'] = String(index)
      const stamp = document.createElement('button')
      stamp.type = 'button'
      stamp.className = 'rp-stamp'
      stamp.textContent = shortClock(line.startMs / 1000)
      stamp.setAttribute('aria-label', `Ir a ${shortClock(line.startMs / 1000)} en la grabación`)
      stamp.disabled = !withStamps
      stamp.addEventListener('click', () => seek(line.startMs / 1000))
      const words = element('div', 'rp-words')
      words.append(element('span', 'rp-who', line.who), element('p', 'rp-text', line.text))
      item.append(stamp, words)
      list.append(item)
    })
    return list
  }

  function lineAt(ms: number): number {
    let found = -1
    for (const [index, line] of lines.entries()) {
      if (line.startMs > ms) break
      found = index
    }
    return found
  }

  function recording(view: MeetingView): HTMLElement {
    const box = element('div', 'rp-player')
    if (view.recording === null) {
      box.append(element('p', 'rp-empty', 'Esta reunión no tiene grabación en este equipo.'))
      return box
    }
    const video = hasVideo(view) || (view.mode !== 'in-person' && view.hasVideo)
    const node = document.createElement(video ? 'video' : 'audio')
    node.className = video ? 'rp-media rp-media--video' : 'rp-media'
    node.controls = true
    node.preload = 'metadata'
    node.src = mediaSrc(view.recording)
    media = node
    const stage = element('div', video ? 'rp-stage rp-stage--video' : 'rp-stage')
    const caption = element('p', 'rp-caption')
    caption.hidden = true
    stage.append(node, caption)
    const tools = element('div', 'rp-player-tools')
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = 'rl-icon'
    toggle.setAttribute('aria-label', 'Subtítulos')
    toggle.title = 'Subtítulos'
    toggle.setAttribute('aria-pressed', String(captions))
    toggle.append(icon('captions', 15))
    const full = document.createElement('button')
    full.type = 'button'
    full.className = 'rl-icon'
    full.setAttribute('aria-label', 'Pantalla completa')
    full.title = 'Pantalla completa'
    full.append(icon('fullscreen', 14))
    full.hidden = !video
    full.addEventListener('click', () => void stage.requestFullscreen().catch(() => undefined))
    tools.append(element('span', 'rp-label', video ? 'Video' : 'Audio'), element('span', 'spacer'), toggle, full)
    const list = transcriptList(true)
    let last = -2
    const sync = (): void => {
      const at = lineAt(node.currentTime * 1000)
      const line = at === -1 ? undefined : lines[at]
      caption.textContent = line?.text ?? ''
      caption.hidden = !captions || line === undefined
      if (at === last) return
      last = at
      for (const row of list.querySelectorAll<HTMLElement>('.rp-line--now')) row.classList.remove('rp-line--now')
      const current = list.querySelector<HTMLElement>(`.rp-line[data-index="${at}"]`)
      if (current === null) return
      current.classList.add('rp-line--now')
      if (!node.paused) list.scrollTo({ top: Math.max(0, current.offsetTop - list.clientHeight / 2), behavior: 'smooth' })
    }
    toggle.addEventListener('click', () => {
      captions = !captions
      toggle.setAttribute('aria-pressed', String(captions))
      sync()
    })
    node.addEventListener('timeupdate', sync)
    node.addEventListener('seeked', sync)
    box.append(stage, tools, list)
    queueMicrotask(applySeek)
    return box
  }

  function releaseMedia(): void {
    if (media === null) return
    media.pause()
    media.removeAttribute('src')
    media.load()
    media = null
  }

  function paintBody(): void {
    releaseMedia()
    if (loaded === null) {
      body.replaceChildren(element('p', 'rp-empty', 'Leyendo la reunión…'))
      return
    }
    const view = loaded.view
    if (view === null && loaded.summary === null && loaded.transcript === null) {
      body.replaceChildren(element('p', 'rp-empty', loaded.problem ?? 'La grabación ya no está en este equipo.'))
      return
    }
    if (tab === 'minuta') body.replaceChildren(minuta())
    else if (tab === 'transcripcion') body.replaceChildren(transcriptList(view?.recording !== null && view !== null))
    else if (view !== null) body.replaceChildren(recording(view))
    else body.replaceChildren(element('p', 'rp-empty', 'Esta reunión no tiene grabación en este equipo.'))
  }

  function paint(): void {
    paintHead()
    paintTabs()
    paintBody()
  }

  paint()
  void loadMeeting(row.id, options.summaryJson, options.transcriptJson).then((result) => {
    if (disposed) return
    loaded = result
    lines = result.transcript !== null ? linesFromRecap(result.transcript) : linesFromSegments(result.view?.segments ?? [])
    paint()
  })

  return {
    root,
    tab(next) {
      if (next === tab) {
        applySeek()
        return
      }
      tab = next
      paintTabs()
      paintBody()
    },
    dispose() {
      disposed = true
      releaseMedia()
    },
  }
}
