import type { PageDocument, PageEntryRow, PageIssue, Problem } from '../bita.ts'
import { element, icon } from '../dom.ts'
import { renderMarkdown } from './markdown.ts'
import { resetPage } from './mermaid.ts'
import { anchorOf } from './sections.ts'
import { proseControl } from './prose.ts'
import './reader.css'
import { assetsRelDirOf } from './drawio.ts'
import { foldForSearch } from './markdown.ts'
import { renderAnswers, renderProposals } from './proposals.ts'
import { modKey } from '../platform.ts'
import {
  meetingChip,
  renderMinutes,
  renderRoom,
  tabBar,
  type MeetingContext,
  type MeetingTab,
} from './meeting.ts'

export interface ReaderHandlers {
  onPrev: () => void
  onNext: () => void
  onCopy: (text: string) => void
  onOpenDocument: (relPath: string) => void
  onOpenExternal: (url: string) => void
  onHit: (delta: number) => void
  onCrumb: (pageId: number) => void
  onExpandRail: () => void
  onExpandAside: () => void
  onMeetingTab: (tab: MeetingTab) => void
  onSeek: (seconds: number) => void
  onExport: () => void
  onCompress: () => void
  onStripVideo: () => void
  onHistory: () => void
  onOpenPage: (pageId: number) => void
  onMeetingChanged: () => void
  onCopyLink?: () => void
}

export interface VideoActions {
  compressing: boolean
}

export interface ReaderState {
  page: PageDocument | null
  query: string
  hit: number
  hitCount: number
  failure: Problem | null
  loading: boolean
  canPrev: boolean
  canNext: boolean
  railOpen: boolean
  asideOpen: boolean
  meeting: MeetingContext | null
  video: VideoActions | null
  history: boolean
  confluenceUrl?: string | null
}

export function renderReader(host: HTMLElement, state: ReaderState, handlers: ReaderHandlers): void {
  if (state.failure !== null) {
    host.replaceChildren(bar(state, handlers), failure(state.failure))
    return
  }

  if (state.loading) {
    host.replaceChildren(bar(state, handlers), element('p', 'placeholder', 'Leyendo…'))
    return
  }

  if (state.page === null) {
    host.replaceChildren(bar(state, handlers), welcome())
    return
  }

  const meeting = state.meeting
  if (meeting === null || meeting.tab === 'document') {
    host.replaceChildren(bar(state, handlers), header(state, handlers), body(state, handlers), footer(state, handlers))
    return
  }

  const meetingHandlers = {
    onTab: handlers.onMeetingTab,
    onSeek: handlers.onSeek,
    onLink: handlers.onOpenExternal,
    onCopy: handlers.onCopy,
  }
  const query = state.query.trim()
  const extra = {
    project: state.page.projectName,
    onSeek: handlers.onSeek,
    onCopy: handlers.onCopy,
    onLink: handlers.onOpenExternal,
    onOpenPage: handlers.onOpenPage,
    onChanged: handlers.onMeetingChanged,
  }
  const ready = meeting.load.state === 'ready' ? meeting.load.view : null
  const content =
    meeting.tab === 'minutes'
      ? renderMinutes(meeting, meetingHandlers, query)
      : meeting.tab === 'proposals' && ready !== null
        ? renderProposals(ready, extra)
        : meeting.tab === 'answers' && ready !== null
          ? renderAnswers(ready, extra)
          : renderRoom(meeting, meetingHandlers, query)
  host.replaceChildren(bar(state, handlers), header(state, handlers), content)
}

function bar(state: ReaderState, handlers: ReaderHandlers): HTMLElement {
  const row = element('div', 'reader-bar')
  row.setAttribute('data-tauri-drag-region', '')

  if (!state.railOpen) {
    row.append(iconAction('panelLeft', 'Desplegar el árbol', handlers.onExpandRail))
  }

  const crumb = element('nav', 'reader-crumb')
  crumb.setAttribute('aria-label', 'Dónde estás')
  const page = state.page
  if (page !== null) {
    const parts: (HTMLElement | Text)[] = []
    parts.push(element('span', 'crumb-space', page.projectName ?? 'Sin proyecto'))
    for (const ancestor of page.ancestors) {
      parts.push(element('span', 'crumb-sep', '/'))
      const link = document.createElement('button')
      link.type = 'button'
      link.className = 'crumb-link'
      link.textContent = ancestor.title
      link.addEventListener('click', () => {
        handlers.onCrumb(ancestor.pageId)
      })
      parts.push(link)
    }
    parts.push(element('span', 'crumb-sep', '/'))
    parts.push(element('span', 'crumb-here', page.title))
    crumb.append(...parts)
  }
  row.append(crumb)

  if (state.query.trim().length > 0 && state.hitCount > 0) {
    const nav = element('span', 'hit-nav')
    nav.append(element('span', 'hit-count', `«${state.query.trim()}» ${state.hit + 1} de ${state.hitCount}`))
    nav.append(iconAction('up', 'Coincidencia anterior', () => handlers.onHit(-1)))
    nav.append(iconAction('down', 'Coincidencia siguiente', () => handlers.onHit(1)))
    nav.append(element('span', 'kbd hit-key', modKey('G')))
    row.append(nav)
  }

  if (page !== null && state.video !== null) {
    if (state.video.compressing) {
      const busy = textAction('compress', 'Comprimiendo…', () => undefined)
      busy.disabled = true
      busy.classList.add('bar-action--busy')
      row.append(busy)
    } else {
      row.append(textAction('compress', 'Comprimir video', handlers.onCompress))
      row.append(textAction('trash', 'Borrar video', handlers.onStripVideo))
    }
  }
  if (page !== null && state.history && (state.meeting === null || state.meeting.tab === 'document')) {
    row.append(textAction('history', 'Historial', handlers.onHistory))
  }
  if (page !== null && handlers.onCopyLink !== undefined) {
    row.append(iconAction('link', 'Copiar el enlace', handlers.onCopyLink))
  }
  const confluence = state.confluenceUrl ?? null
  if (page !== null && confluence !== null) {
    row.append(iconAction('external', 'Abrir en Confluence', () => handlers.onOpenExternal(confluence)))
  }
  if (page !== null) row.append(textAction('download', 'Exportar PDF', handlers.onExport))
  if (page !== null && (state.meeting === null || state.meeting.tab === 'document')) row.append(proseControl())

  row.append(iconAction('prev', 'Página anterior', handlers.onPrev, !state.canPrev))
  row.append(iconAction('next', 'Página siguiente', handlers.onNext, !state.canNext))

  if (!state.asideOpen) {
    row.append(iconAction('panelRight', 'Desplegar el panel', handlers.onExpandAside))
  }
  return row
}

function textAction(glyph: 'compress' | 'trash' | 'download' | 'history', label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'bar-action'
  button.append(icon(glyph, 13), element('span', '', label))
  button.addEventListener('click', onClick)
  return button
}

function iconAction(
  name: 'prev' | 'next' | 'up' | 'down' | 'panelLeft' | 'panelRight' | 'link' | 'external',
  label: string,
  onClick: () => void,
  disabled = false,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'icon-button reader-step'
  button.setAttribute('aria-label', label)
  button.disabled = disabled
  button.append(icon(name, 14))
  button.addEventListener('click', onClick)
  return button
}

function header(state: ReaderState, handlers: ReaderHandlers): HTMLElement {
  const page = state.page as PageDocument
  if (state.meeting !== null && state.meeting.tab !== 'document') {
    const compact = element('div', 'doc-header doc-header--meeting')
    const line = element('div', 'doc-title-row')
    const heading = element('h1', 'doc-title', page.title)
    heading.tabIndex = -1
    line.append(heading, meetingChip(state.meeting.info, state.meeting.load))
    compact.append(line, tabBar(state.meeting, handlers.onMeetingTab))
    return compact
  }

  const head = element('div', 'doc-header')

  const title = element('h1', 'doc-title', page.title)
  title.tabIndex = -1
  head.append(title)

  const meta = element('div', 'doc-meta')
  meta.append(element('span', 'doc-when', `Al día a ${spanish(page.recordedAt.slice(0, 10))}`))
  meta.append(element('span', 'doc-repo', page.projectSlug))
  if (page.doc.file.status === 'changed') {
    meta.append(element('span', 'pill pill--warn', 'editada fuera de inkwell'))
  }
  if (page.doc.file.status === 'missing') {
    meta.append(element('span', 'pill pill--warn', 'el archivo no está'))
  }
  head.append(meta)

  if (page.issues.length > 0) head.append(tasks(page.issues, handlers))
  if (state.meeting !== null) {
    head.append(meetingChip(state.meeting.info, state.meeting.load))
    head.append(tabBar(state.meeting, handlers.onMeetingTab))
  }
  return head
}

function tasks(issues: PageIssue[], handlers: ReaderHandlers): HTMLElement {
  const band = element('div', 'task-band')
  band.append(element('span', 'task-label', 'Tareas'))

  for (const issue of issues) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'task-chip'
    chip.disabled = issue.url === null
    if (issue.summary.length > 0) chip.title = issue.summary

    const dot = element('span', 'dot')
    dot.style.background = categoryColor(issue.statusCategory)
    chip.append(dot, element('span', '', issue.issueKey))

    if (issue.url !== null) {
      const url = issue.url
      chip.addEventListener('click', () => {
        handlers.onOpenExternal(url)
      })
    }
    band.append(chip)
  }
  return band
}

function body(state: ReaderState, handlers: ReaderHandlers): HTMLElement {
  resetPage()
  const wrap = element('div', 'doc-body')
  const article = element('article', 'article')
  const page = state.page as PageDocument

  if (page.doc.markdown === null) {
    article.append(gone(page.doc.path))
    wrap.append(article)
    return wrap
  }

  const anchors = page.doc.outline.filter((heading) => heading.level === 2).map((heading) => heading.anchor)
  const blocks = splitSections(page.doc.markdown)

  if (blocks.lede.trim().length > 0) {
    article.append(render(blocks.lede, state, handlers, 'doc-lede'))
  }

  if (blocks.sections.length === 0 && blocks.lede.trim().length === 0) {
    article.append(element('p', 'doc-section-blank', 'Esta página todavía no dice nada.'))
  }

  for (const [index, section] of blocks.sections.entries()) {
    const block = element('section', 'doc-section')
    block.id = anchors[index] ?? anchorOf(section.heading)
    block.dataset['heading'] = section.heading
    block.append(element('h2', 'doc-section-title', section.heading))
    if (section.body.trim().length > 0) block.append(render(section.body, state, handlers))
    article.append(block)
  }

  const matching = matchingEntries(page.entries, state.query)
  if (matching.length > 0) {
    const block = element('section', 'doc-section doc-entries')
    block.append(element('h2', 'doc-section-title', 'Desde las entradas del cronómetro'))
    for (const entry of matching) {
      const card = element('div', 'doc-entry')
      card.dataset['hitLabel'] = `Entrada ${shortDay(entry.localDay)}`
      card.append(element('span', 'kbd', `${shortDay(entry.localDay)} · ${entry.durationHuman}`))
      card.append(render(entry.summary.trim().length > 0 ? entry.summary : entry.title, state, handlers))
      block.append(card)
    }
    article.append(block)
  }

  wrap.append(article)
  return wrap
}

function matchingEntries(entries: PageEntryRow[], query: string): PageEntryRow[] {
  const needle = foldForSearch(query.trim())
  if (needle.length === 0) return []
  return entries.filter((entry) => foldForSearch(`${entry.title}\n${entry.summary}`).includes(needle))
}

function render(markdown: string, state: ReaderState, handlers: ReaderHandlers, className?: string): Node {
  const page = state.page
  const rendered = renderMarkdown(markdown, {
    ...(state.query.trim().length > 0 ? { highlight: state.query.trim() } : {}),
    onLink: handlers.onOpenExternal,
    onCopy: handlers.onCopy,
    ...(page !== null
      ? {
          drawio: {
            pageId: page.pageId,
            assetsRelDir: assetsRelDirOf(page.doc.relPath),
            onOpen: handlers.onOpenDocument,
          },
        }
      : {}),
  })
  if (className === undefined) return rendered
  const wrap = element('div', className)
  wrap.appendChild(rendered)
  return wrap
}

function gone(path: string): HTMLElement {
  const box = element('div', 'no-doc')
  box.append(element('span', 'no-doc-title', 'El archivo ya no está'))
  box.append(element('p', 'no-doc-note', 'La base lo tiene registrado, pero en el disco no hay nada en esa ruta.'))
  const code = element('pre', 'install-log')
  code.textContent = path
  box.append(code)
  return box
}

function welcome(): HTMLElement {
  const wrap = element('div', 'reader-welcome')
  const empty = element('div', 'empty')
  empty.append(element('div', 'empty-title', 'Elige una página'))
  empty.append(
    element('div', 'empty-note', 'A la izquierda están los espacios. Cada página cuenta cómo está algo hoy.'),
  )
  wrap.append(empty)
  return wrap
}

function failure(problem: Problem): HTMLElement {
  const box = element('div', 'problem')
  box.append(element('div', 'problem-message', problem.message))
  if (problem.hint) box.append(element('div', 'problem-hint', problem.hint))
  return box
}

function footer(state: ReaderState, handlers: ReaderHandlers): HTMLElement {
  const bar = element('div', 'reader-foot')
  const page = state.page as PageDocument
  bar.append(element('span', 'doc-path', page.doc.relPath))

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.className = 'ghost-button'
  copy.textContent = 'Copiar markdown'
  copy.disabled = page.doc.markdown === null
  copy.addEventListener('click', () => {
    if (page.doc.markdown !== null) handlers.onCopy(page.doc.markdown)
  })

  const open = document.createElement('button')
  open.type = 'button'
  open.className = 'ghost-button'
  open.textContent = 'Abrir en el editor'
  open.addEventListener('click', () => {
    handlers.onOpenDocument(page.doc.relPath)
  })

  bar.append(copy, open)
  return bar
}

export interface SplitDocument {
  lede: string
  sections: { heading: string; body: string }[]
}

const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})/

export function withoutFrontMatter(markdown: string): string {
  const text = markdown.startsWith('\ufeff') ? markdown.slice(1) : markdown
  if (!text.startsWith('---\n')) return text

  const closing = text.indexOf('\n---\n', 3)
  if (closing === -1) return text
  return text.slice(closing + 5)
}

export function splitSections(markdown: string): SplitDocument {
  const sections: { heading: string; body: string }[] = []
  const lede: string[] = []
  let current: { heading: string; body: string[] } | null = null
  let fence: { char: string; length: number } | null = null

  for (const line of withoutFrontMatter(markdown).split('\n')) {
    const marker = CODE_FENCE.exec(line)?.[1]
    if (fence !== null) {
      if (marker !== undefined && marker.slice(0, 1) === fence.char && marker.length >= fence.length) fence = null
      if (current) current.body.push(line)
      else lede.push(line)
      continue
    }
    if (marker !== undefined) {
      fence = { char: marker.slice(0, 1), length: marker.length }
      if (current) current.body.push(line)
      else lede.push(line)
      continue
    }

    const found = /^##\s+(.*\S)\s*$/.exec(line)
    if (found?.[1] !== undefined) {
      if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() })
      current = { heading: found[1], body: [] }
      continue
    }

    if (/^#\s+/.test(line) && current === null && sections.length === 0) continue
    if (current) current.body.push(line)
    else lede.push(line)
  }

  if (current) sections.push({ heading: current.heading, body: current.body.join('\n').trim() })
  return { lede: lede.join('\n').trim(), sections }
}

function categoryColor(category: PageIssue['statusCategory']): string {
  if (category === 'done') return 'var(--ok)'
  if (category === 'indeterminate') return 'var(--estimate)'
  if (category === 'new') return 'var(--blue)'
  return 'var(--elev-strong)'
}

function shortDay(localDay: string): string {
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
  const [, month, day] = localDay.split('-')
  return `${(day ?? '').padStart(2, '0')} ${months[Number(month) - 1] ?? ''}`.trim()
}

function spanish(localDay: string): string {
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
  const [year, month, day] = localDay.split('-')
  return `${Number(day)} ${months[Number(month) - 1] ?? ''} ${year ?? ''}`.trim()
}
