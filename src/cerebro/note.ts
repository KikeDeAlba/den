import { copyText, describeProblem } from '../bita.ts'
import { element, iconButton } from '../dom.ts'
import { renderMarkdown } from '../notes/markdown.ts'
import { brainShow, type BrainDetail } from './api.ts'
import { EDGE_LABELS, KIND_LABELS, type Palette } from './palette.ts'
import { day, detailMeta, kindDot } from './side.ts'

export interface NoteHandlers {
  palette: () => Palette
  onNavigate: (id: string) => void
  onLink: (url: string) => void
  onClose: () => void
}

export interface NoteDialog {
  open(id: string, known?: BrainDetail | null): void
  close(): void
  isOpen(): boolean
  dispose(): void
}

const TITLE_ID = 'brain-note-title'

export function createNoteDialog(host: HTMLElement, handlers: NoteHandlers): NoteDialog {
  const dialog = document.createElement('dialog')
  dialog.className = 'brain-note'
  dialog.setAttribute('aria-labelledby', TITLE_ID)

  const head = element('header', 'brain-note-head')
  const heading = element('div', 'brain-note-heading')
  const tag = element('span', 'brain-kind')
  const title = element('h2', 'brain-note-title')
  title.id = TITLE_ID
  const meta = element('span', 'brain-note-meta')
  heading.append(tag, title, meta)
  const copy = iconButton('copy', 'brain-icon-button', 'Copiar el id de la nota')
  const close = iconButton('close', 'brain-icon-button', 'Cerrar')
  head.append(heading, copy, close)

  const scroll = element('div', 'brain-note-scroll')
  const column = element('div', 'brain-note-column')
  const article = element('article', 'brain-note-body')
  column.append(article)
  const aside = element('aside', 'brain-note-aside')
  scroll.append(column, aside)

  const foot = element('footer', 'brain-note-foot')
  foot.append(element('span', '', 'clic en una conexión para saltar a ella'), element('span', '', 'esc cerrar'))

  dialog.append(head, scroll, foot)
  host.append(dialog)

  let token = 0
  let current: BrainDetail | null = null

  const fill = (detail: BrainDetail): void => {
    const palette = handlers.palette()
    current = detail
    tag.textContent = KIND_LABELS[detail.kind]
    tag.style.setProperty('--dot', palette.kinds[detail.kind])
    title.textContent = detail.title
    meta.textContent = detailMeta(detail)

    if (detail.body.trim() === '') article.replaceChildren(element('p', 'brain-side-quiet', 'Esta nota no tiene contenido.'))
    else article.replaceChildren(renderMarkdown(detail.body, { onLink: handlers.onLink }))

    const links: HTMLElement[] = [element('h3', 'brain-side-heading', `Conexiones · ${detail.neighbors.length}`)]
    if (detail.neighbors.length === 0) links.push(element('p', 'brain-side-quiet', 'Sin conexiones.'))
    for (const neighbor of detail.neighbors) {
      const button = element('button', 'brain-note-link') as HTMLButtonElement
      button.type = 'button'
      const name = element('span', 'brain-note-link-title')
      name.append(kindDot(palette.kinds[neighbor.kind]), element('span', '', neighbor.title))
      button.append(name, element('span', 'brain-note-link-kind', `${KIND_LABELS[neighbor.kind]} · ${EDGE_LABELS[neighbor.edgeKind]}`))
      button.addEventListener('click', () => handlers.onNavigate(neighbor.id))
      links.push(button)
    }
    links.push(element('h3', 'brain-side-heading brain-note-data', 'Datos'))
    const created = day(detail.createdAt)
    if (created !== null) links.push(element('span', 'brain-note-fact', `Creada ${created}`))
    links.push(element('code', 'brain-note-id', detail.id))
    aside.replaceChildren(...links)
    scroll.scrollTop = 0
  }

  const show = (): void => {
    if (!dialog.open) {
      dialog.showModal()
      close.focus()
    }
  }

  const load = async (id: string): Promise<void> => {
    const mine = ++token
    tag.textContent = ''
    title.textContent = 'Cargando…'
    meta.textContent = ''
    article.replaceChildren()
    aside.replaceChildren()
    try {
      const detail = await brainShow(id)
      if (mine === token) fill(detail)
    } catch (error) {
      if (mine !== token) return
      const problem = describeProblem(error)
      title.textContent = 'No pude abrir la nota'
      article.replaceChildren(element('p', 'brain-side-error', problem.message))
      if (problem.hint !== null) article.append(element('code', 'brain-hint', problem.hint))
    }
  }

  copy.addEventListener('click', () => {
    if (current !== null) void copyText(current.id).catch(() => undefined)
  })
  close.addEventListener('click', () => dialog.close())
  dialog.addEventListener('close', () => {
    token += 1
    handlers.onClose()
  })
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close()
  })

  return {
    open(id, known = null) {
      if (known !== null && known.id === id) {
        token += 1
        fill(known)
      } else {
        void load(id)
      }
      show()
    },
    close() {
      if (dialog.open) dialog.close()
    },
    isOpen: () => dialog.open,
    dispose() {
      token += 1
      if (dialog.open) dialog.close()
      dialog.remove()
    },
  }
}
