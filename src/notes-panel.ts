import type { LiveTimer, NoteRow } from './bita.ts'
import { element, icon } from './dom.ts'
import { entryRoute } from './sections/docs/route.ts'
import { go } from './shell/routes.ts'
import { projectColor } from './tabs.ts'

export function timerDoc(timer: LiveTimer): HTMLElement | null {
  const total = timer.sectionsTotal
  if (total === null || total === 0) return null

  const block = element('div', 'timer-doc')

  const row = element('div', 'timer-doc-row')
  const mark = element('span', 'timer-doc-mark')
  mark.append(icon('doc', 13))
  row.append(mark)

  const written = timer.sectionsWritten ?? 0
  row.append(element('span', 'timer-doc-count', `${written} de ${total} secciones escritas`))

  const link = document.createElement('button')
  link.type = 'button'
  link.className = 'quiet-link timer-doc-link'
  link.append(element('span', undefined, 'Ver nota'))
  link.append(icon('next', 11))
  link.addEventListener('click', () => {
    go(entryRoute(timer.id))
  })
  row.append(link)
  block.append(row)

  const touched = timer.touchedSinceNote ?? 0
  if (touched > 0) {
    block.append(
      element(
        'div',
        'timer-doc-estimate',
        `${touched} ${touched === 1 ? 'archivo tocado' : 'archivos tocados'} desde la última nota`,
      ),
    )
  }

  return block
}

export function todayNotes(rows: NoteRow[]): HTMLElement | null {
  if (rows.length === 0) return null

  const wrap = element('div', 'today-notes')

  const head = element('div', 'section-head')
  head.append(element('span', 'section-label', 'Notas de hoy'))
  const all = document.createElement('button')
  all.type = 'button'
  all.className = 'quiet-link'
  all.textContent = 'Abrir todas'
  all.addEventListener('click', () => {
    go('docs')
  })
  head.append(element('span', 'spacer'), all)
  wrap.append(head)

  const list = element('div', 'today-list')
  for (const row of rows) list.append(noteRow(row))
  wrap.append(list)
  return wrap
}

function noteRow(row: NoteRow): HTMLElement {
  if (row.doc === null) {
    const quiet = element('div', 'today-note today-note--empty')
    quiet.append(dot(row, false))
    const text = element('span', 'today-note-text')
    text.append(element('span', 'today-note-title', row.title.trim() || 'Sin título'))
    text.append(element('span', 'pill pill--empty', 'sin nota'))
    quiet.append(text)
    return quiet
  }

  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'today-note'
  button.append(dot(row, true))

  const text = element('span', 'today-note-text')
  text.append(element('span', 'today-note-title', row.doc.docTitle || row.title || 'Sin título'))

  const written = row.doc.sections?.filter((section) => section.state === 'written').length ?? 0
  const total = row.doc.sections?.filter((section) => section.canonical).length ?? 7
  text.append(
    element(
      'span',
      'today-note-meta',
      `${row.projectName ?? 'sin proyecto'} · ${row.durationHuman} · ${written} de ${total} secciones`,
    ),
  )
  button.append(text)

  const chevron = element('span', 'today-note-go')
  chevron.append(icon('chevronRight', 12))
  button.append(chevron)

  button.addEventListener('click', () => {
    go(entryRoute(row.entryId))
  })
  return button
}

function dot(row: NoteRow, filled: boolean): HTMLElement {
  const mark = element('i', 'dot')
  if (filled) mark.style.background = projectColor(row.projectId)
  else mark.style.border = '1px solid var(--elev-strong)'
  return mark
}
