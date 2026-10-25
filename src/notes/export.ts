import {
  describeProblem,
  exportPdf,
  meetingForEntry,
  pageDocument,
  type PageDocument,
  type PageNode,
  type Space,
} from '../bita.ts'
import { element, icon } from '../dom.ts'
import { assetsRelDirOf } from './drawio.ts'
import { renderMarkdown } from './markdown.ts'
import { latestMeeting, minutesBody, paragraphsOf, shortClock } from './meeting.ts'
import { resetPage } from './mermaid.ts'
import { splitSections } from './reader.ts'
import './export.css'

export interface ExportOptions {
  root: PageNode
  space: Space
  client: string | null
  onOpenDocument: (relPath: string) => void
}

interface Choice {
  cover: boolean
  diagrams: boolean
  minutes: boolean
  transcript: boolean
  entries: boolean
}

interface Item {
  page: PageNode
  depth: number
  number: string
}

const BYTES_PER_SHEET = 3200
const DIAGRAM_WAIT_MS = 20_000
const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

let openDialog: HTMLElement | null = null

function flatten(root: PageNode): Item[] {
  const items: Item[] = []
  const walk = (page: PageNode, depth: number, number: string): void => {
    items.push({ page, depth, number })
    ;(page.children ?? []).forEach((child, index) => walk(child, depth + 1, `${number}.${index + 1}`))
  }
  walk(root, 0, '1')
  return items
}

function sheetsOf(page: PageNode): number {
  return Math.max(1, Math.ceil(page.byteSize / BYTES_PER_SHEET))
}

function today(): string {
  const now = new Date()
  return `${String(now.getDate()).padStart(2, '0')} ${MONTHS[now.getMonth()] ?? ''} ${now.getFullYear()}`
}

function slugOf(page: PageNode): string {
  const base = page.slug.length > 0 ? page.slug : page.title
  return (
    base
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'documentacion'
  )
}

function toggle(label: string, on: boolean, note: string | null, onChange: (value: boolean) => void): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'export-option'
  row.setAttribute('role', 'switch')
  row.setAttribute('aria-checked', String(on))
  const knob = element('span', on ? 'export-switch export-switch--on' : 'export-switch')
  row.append(knob, element('span', 'export-option-label', label))
  if (note !== null) row.append(element('span', 'kbd', note))
  row.addEventListener('click', () => {
    const next = row.getAttribute('aria-checked') !== 'true'
    row.setAttribute('aria-checked', String(next))
    knob.classList.toggle('export-switch--on', next)
    onChange(next)
  })
  return row
}

export function openExportDialog(options: ExportOptions): void {
  openDialog?.remove()
  const items = flatten(options.root)
  const picked = new Set(items.map((item) => item.page.pageId))
  const choice: Choice = { cover: true, diagrams: true, minutes: true, transcript: false, entries: false }
  const fileName = slugOf(options.root)
  const meetingPages = items.filter((item) => latestMeeting(item.page.meetings) !== null)

  const overlay = element('div', 'export-overlay')
  const dialog = element('section', 'export-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', 'export-title')
  overlay.append(dialog)

  const head = element('div', 'export-head')
  const title = element('h2', 'export-title', 'Exportar a PDF')
  title.id = 'export-title'
  head.append(title, element('span', 'kbd', `desde «${options.root.title}»`))

  const main = element('div', 'export-main')
  const left = element('div', 'export-left')
  const tree = element('div', 'export-tree')
  tree.append(element('span', 'export-label', 'Páginas que entran'))
  const boxes = new Map<number, HTMLInputElement>()

  for (const item of items) {
    const row = element('label', 'export-check')
    row.style.paddingLeft = `${item.depth * 24}px`
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = true
    boxes.set(item.page.pageId, box)
    const name = element('span', item.depth === 0 ? 'export-page export-page--root' : 'export-page', item.page.title)
    const meeting = latestMeeting(item.page.meetings) !== null
    const note = item.depth === 0 ? 'esta página' : meeting ? 'reunión' : `${sheetsOf(item.page)} ${sheetsOf(item.page) === 1 ? 'hoja' : 'hojas'}`
    row.append(box, name, element('span', 'kbd export-note', note))
    box.addEventListener('change', () => {
      const subtree = flatten(item.page).map((inner) => inner.page.pageId)
      for (const id of subtree) {
        const other = boxes.get(id)
        if (other === undefined) continue
        other.checked = box.checked
        if (box.checked) picked.add(id)
        else picked.delete(id)
        other.closest('.export-check')?.classList.toggle('export-check--off', !box.checked)
      }
      refresh()
    })
    tree.append(row)
  }

  const optionsBlock = element('div', 'export-options')
  optionsBlock.append(element('span', 'export-label', 'Opciones'))
  const transcriptNote = meetingPages.length === 0 ? null : `+${Math.max(1, meetingPages.length * 6)} hojas`
  optionsBlock.append(
    toggle('Portada e índice', choice.cover, null, (value) => {
      choice.cover = value
      refresh()
    }),
    toggle('Diagramas (mermaid y draw.io)', choice.diagrams, null, (value) => {
      choice.diagrams = value
    }),
    toggle('Minuta de las reuniones', choice.minutes, meetingPages.length === 0 ? 'sin reuniones' : null, (value) => {
      choice.minutes = value
    }),
    toggle('Transcripción completa', choice.transcript, transcriptNote, (value) => {
      choice.transcript = value
      refresh()
    }),
    toggle('Entradas del cronómetro', choice.entries, null, (value) => {
      choice.entries = value
    }),
  )
  left.append(tree, optionsBlock)

  const right = element('div', 'export-preview')
  const paper = element('div', 'export-paper')
  const sheetNote = element('span', 'kbd')
  right.append(paper, sheetNote)
  main.append(left, right)

  const foot = element('div', 'export-foot')
  const status = element('span', 'kbd export-status', `Se guarda en ~/Downloads/${fileName}.pdf`)
  const cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'export-button'
  cancel.textContent = 'Cancelar'
  const confirm = document.createElement('button')
  confirm.type = 'button'
  confirm.className = 'export-button export-button--primary'
  confirm.append(icon('download', 13), element('span', '', 'Exportar PDF'))
  foot.append(status, cancel, confirm)

  dialog.append(head, main, foot)

  function refresh(): void {
    const chosen = items.filter((item) => picked.has(item.page.pageId))
    paper.replaceChildren()
    paper.append(
      element('span', 'export-paper-kicker', [options.space.projectName ?? 'Sin proyecto', options.client].filter(Boolean).join(' · ')),
      element('span', 'export-paper-title', options.root.title),
      element('span', 'export-paper-meta', `${today()} · ${chosen.length} ${chosen.length === 1 ? 'página' : 'páginas'}`),
    )
    if (choice.cover) {
      paper.append(element('span', 'export-paper-rule'), element('span', 'export-paper-index', 'Índice'))
      for (const item of chosen.slice(0, 9)) {
        const line = element('span', 'export-paper-line')
        line.style.paddingLeft = `${item.depth * 8}px`
        line.append(element('span', '', `${item.number} ${item.page.title}`))
        paper.append(line)
      }
    }
    const sheets =
      (choice.cover ? 1 : 0) +
      chosen.reduce((total, item) => total + sheetsOf(item.page), 0) +
      (choice.transcript ? chosen.filter((item) => latestMeeting(item.page.meetings) !== null).length * 6 : 0)
    sheetNote.textContent = `1 de ${Math.max(1, sheets)} hojas · carta`
    confirm.disabled = chosen.length === 0
  }

  const close = (): void => {
    overlay.remove()
    document.removeEventListener('keydown', onKey, true)
    if (openDialog === overlay) openDialog = null
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && !confirm.classList.contains('export-button--busy')) {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }
  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay && !confirm.classList.contains('export-button--busy')) close()
  })
  cancel.addEventListener('click', close)
  confirm.addEventListener('click', () => {
    const chosen = items.filter((item) => picked.has(item.page.pageId))
    confirm.disabled = true
    cancel.disabled = true
    confirm.classList.add('export-button--busy')
    status.textContent = 'Preparando las páginas…'
    status.classList.remove('export-status--error')
    void runExport(chosen, choice, options, fileName, (text) => {
      status.textContent = text
    })
      .then((path) => {
        status.textContent = `Guardado en ${path.replace(/^\/Users\/[^/]+/, '~')}`
        window.setTimeout(close, 1200)
      })
      .catch((error: unknown) => {
        status.textContent = describeProblem(error).message
        status.classList.add('export-status--error')
        confirm.disabled = false
        cancel.disabled = false
        confirm.classList.remove('export-button--busy')
      })
  })

  refresh()
  document.addEventListener('keydown', onKey, true)
  const host = document.querySelector<HTMLElement>('.section-host:not([hidden]) .notes-root') ?? document.body
  host.append(overlay)
  openDialog = overlay
  confirm.focus()
}

async function runExport(
  chosen: Item[],
  choice: Choice,
  options: ExportOptions,
  fileName: string,
  progress: (text: string) => void,
): Promise<string> {
  const host = document.querySelector<HTMLElement>('.section-host:not([hidden]) .notes-root') ?? document.body
  document.getElementById('print-root')?.remove()
  const root = element('div', choice.diagrams ? 'print-root' : 'print-root print-root--no-diagrams')
  root.id = 'print-root'
  host.append(root)
  try {
    const documents: PageDocument[] = []
    for (const [index, item] of chosen.entries()) {
      progress(`Leyendo ${index + 1} de ${chosen.length}: ${item.page.title}`)
      documents.push((await pageDocument(item.page.pageId)).data)
    }
    if (choice.cover) root.append(cover(chosen, options))
    for (const [index, item] of chosen.entries()) {
      const page = documents[index] as PageDocument
      progress(`Componiendo ${index + 1} de ${chosen.length}: ${item.page.title}`)
      root.append(await pageSheet(item, page, choice, options))
    }
    progress('Dibujando los diagramas…')
    await diagramsSettled(root)
    progress('Guardando el PDF…')
    document.body.classList.add('printing')
    return await exportPdf(fileName)
  } finally {
    document.body.classList.remove('printing')
    root.remove()
  }
}

function cover(chosen: Item[], options: ExportOptions): HTMLElement {
  const sheet = element('section', 'print-cover')
  sheet.append(
    element('div', 'print-kicker', [options.space.projectName ?? 'Sin proyecto', options.client].filter(Boolean).join(' · ')),
    element('h1', 'print-cover-title', options.root.title),
    element('div', 'print-cover-meta', `${today()} · ${chosen.length} ${chosen.length === 1 ? 'página' : 'páginas'}`),
  )
  const index = element('div', 'print-index')
  index.append(element('h2', 'print-index-title', 'Índice'))
  for (const item of chosen) {
    const line = element('div', 'print-index-line')
    line.style.paddingLeft = `${item.depth * 14}px`
    line.append(element('span', 'print-index-number', item.number), element('span', '', item.page.title))
    index.append(line)
  }
  sheet.append(index)
  return sheet
}

function ignoreCopy(): void {}

async function pageSheet(item: Item, page: PageDocument, choice: Choice, options: ExportOptions): Promise<HTMLElement> {
  resetPage()
  const sheet = element('section', 'print-page')
  const crumb = [page.projectName ?? 'Sin proyecto', ...page.ancestors.map((ancestor) => ancestor.title)].join(' / ')
  sheet.append(element('div', 'print-crumb', crumb), element('h1', 'print-title', `${item.number} ${page.title}`))
  const article = element('article', 'article')
  const markdown = page.doc.markdown
  if (markdown === null) {
    article.append(element('p', 'md-paragraph', 'El archivo de esta página ya no está en el disco.'))
  } else {
    const blocks = splitSections(markdown)
    const render = (text: string): Node =>
      renderMarkdown(text, {
        onCopy: ignoreCopy,
        drawio: { pageId: page.pageId, assetsRelDir: assetsRelDirOf(page.doc.relPath), onOpen: options.onOpenDocument },
      })
    if (blocks.lede.trim().length > 0) article.append(render(blocks.lede))
    for (const section of blocks.sections) {
      const block = element('section', 'doc-section')
      block.append(element('h2', 'doc-section-title', section.heading))
      if (section.body.trim().length > 0) block.append(render(section.body))
      article.append(block)
    }
  }
  sheet.append(article)

  const meeting = latestMeeting(page.meetings)
  if (meeting !== null && (choice.minutes || choice.transcript)) {
    try {
      const view = await meetingForEntry(meeting.entryId)
      if (view !== null && choice.minutes && view.summaryMarkdown !== null) {
        const block = element('section', 'print-extra')
        block.append(element('h2', 'doc-section-title', 'Minuta de la reunión'))
        block.append(renderMarkdown(minutesBody(view.summaryMarkdown), { onCopy: ignoreCopy }))
        sheet.append(block)
      }
      if (view !== null && choice.transcript && view.segments.length > 0) {
        const block = element('section', 'print-extra print-transcript')
        block.append(element('h2', 'doc-section-title', 'Transcripción'))
        const labels: Record<string, string> = { mic: 'Sala', system: 'Remotos' }
        for (const paragraph of paragraphsOf(view.segments)) {
          const row = element('p', 'print-line')
          row.append(element('span', 'print-stamp', shortClock(paragraph.startMs / 1000)))
          if (view.mode === 'remote') row.append(element('strong', '', `${labels[paragraph.channel] ?? paragraph.channel}: `))
          row.append(document.createTextNode(paragraph.text))
          block.append(row)
        }
        sheet.append(block)
      }
    } catch {
      sheet.append(element('p', 'md-paragraph', 'No pude leer la reunión de esta página.'))
    }
  }

  if (choice.entries && page.entries.length > 0) {
    const block = element('section', 'print-extra')
    block.append(element('h2', 'doc-section-title', 'Entradas del cronómetro'))
    for (const entry of page.entries) {
      const row = element('div', 'print-entry')
      row.append(element('div', 'print-stamp', `${entry.localDay} · ${entry.durationHuman}`))
      row.append(renderMarkdown(entry.summary.trim().length > 0 ? entry.summary : entry.title))
      block.append(row)
    }
    sheet.append(block)
  }
  return sheet
}

async function diagramsSettled(root: HTMLElement): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < DIAGRAM_WAIT_MS) {
    const pending = [...root.querySelectorAll('.md-mermaid-note')].some((note) =>
      /^(Dibujando|Cargando)/.test(note.textContent ?? ''),
    )
    const loading = [...root.querySelectorAll('img')].some((image) => !image.complete)
    if (!pending && !loading) break
    await new Promise((resolve) => window.setTimeout(resolve, 150))
  }
  await new Promise((resolve) => window.requestAnimationFrame(() => window.requestAnimationFrame(resolve)))
}
