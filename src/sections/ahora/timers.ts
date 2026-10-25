import { isMeetingKind, MEETING_KINDS, type LiveTimer, type Project } from '../../bita.ts'
import { element, icon } from '../../dom.ts'
import { clock, startedAt } from '../../format.ts'
import { projectColor } from '../../shell/colors.ts'
import { entryRoute } from './launch.ts'

export interface Draft {
  title: string
  project: string
  kind: string
  confirmingDiscard: boolean
}

export interface RowActions {
  stop(timer: LiveTimer): void
  rename(timer: LiveTimer): void
  open(route: string): void
}

export interface EditActions {
  discard(timer: LiveTimer): void
  cancel(): void
  save(timer: LiveTimer): void
  confirmDiscard(): void
}

function link(text: string, run: () => void): HTMLButtonElement {
  const button = element('button', 'quiet-link', text) as HTMLButtonElement
  button.type = 'button'
  button.addEventListener('click', run)
  return button
}

function meta(timer: LiveTimer, actions: RowActions): HTMLElement {
  const line = element('span', 'ahora-timer-meta')
  const parts: (string | HTMLElement)[] = [timer.projectName ?? 'sin proyecto']
  const kind = timer.kind
  const meeting = isMeetingKind(kind)
  if (meeting) parts.push(MEETING_KINDS[kind].toLowerCase())
  parts.push(`desde ${startedAt(timer.startLocal)}`)
  if (timer.draft) parts.push(link('ponerle nombre', () => actions.rename(timer)))
  if (meeting) {
    parts.push(link('transcripción', () => actions.open(entryRoute('meeting', timer.id))))
  } else {
    parts.push(link('sesión', () => actions.open(entryRoute('session', timer.id))))
  }
  const total = timer.sectionsTotal ?? 0
  if (total > 0) {
    const written = timer.sectionsWritten ?? 0
    parts.push(link(`nota ${written}/${total}`, () => actions.open(entryRoute('note', timer.id))))
  }
  parts.forEach((part, index) => {
    if (index > 0) line.append(' · ')
    line.append(part)
  })
  return line
}

export function timerRow(timer: LiveTimer, actions: RowActions): HTMLElement {
  const row = element('div', timer.draft ? 'ahora-timer ahora-timer--draft' : 'ahora-timer')
  row.dataset['id'] = String(timer.id)

  const dot = element('i', 'ahora-timer-dot')
  if (!timer.draft) dot.style.background = projectColor(timer.projectId)

  const body = element('div', 'ahora-timer-body')
  const title = element('span', 'ahora-timer-title')
  if (timer.draft) {
    title.append('Sin nombre todavía ', element('span', 'ahora-timer-id', `#${timer.id}`))
  } else {
    title.textContent = timer.title ?? ''
  }
  body.append(title, meta(timer, actions))

  const face = element('span', 'ahora-timer-clock', clock(timer.elapsedSeconds))
  face.dataset['clock'] = String(timer.id)

  const stop = document.createElement('button')
  stop.type = 'button'
  stop.className = 'icon-button'
  stop.setAttribute('aria-label', isMeetingKind(timer.kind) ? 'Parar la reunión' : `Parar el cronómetro ${timer.id}`)
  stop.append(icon('stop', 12))
  stop.addEventListener('click', () => actions.stop(timer))

  row.append(dot, body, face, stop)
  return row
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrap = element('label', 'field')
  wrap.append(element('span', 'field-label', label), control)
  return wrap
}

function option(value: string, label: string): HTMLOptionElement {
  const node = document.createElement('option')
  node.value = value
  node.textContent = label
  return node
}

export function editForm(
  timer: LiveTimer,
  draft: Draft,
  catalog: readonly Project[],
  meetingKinds: boolean,
  actions: EditActions,
): HTMLElement {
  const form = element('div', 'edit ahora-edit')

  const input = document.createElement('input')
  input.type = 'text'
  input.value = draft.title
  input.placeholder = '¿En qué has estado?'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.addEventListener('input', () => {
    draft.title = input.value
  })
  form.append(field('Título', input))

  const project = document.createElement('select')
  project.append(option('', 'Dejarlo sin proyecto'))
  for (const entry of catalog) project.append(option(String(entry.id), entry.name))
  project.value = draft.project
  project.addEventListener('change', () => {
    draft.project = project.value
  })
  form.append(field('Proyecto', project))

  const kind = document.createElement('select')
  kind.append(option('', 'Trabajo'))
  if (meetingKinds || isMeetingKind(draft.kind)) {
    for (const [value, label] of Object.entries(MEETING_KINDS)) kind.append(option(value, label))
  }
  if (draft.kind !== '' && !isMeetingKind(draft.kind)) kind.append(option(draft.kind, draft.kind))
  kind.value = draft.kind
  kind.addEventListener('change', () => {
    draft.kind = kind.value
  })
  form.append(field('Tipo', kind))

  const discard = element(
    'button',
    'quiet-link quiet-link--danger',
    draft.confirmingDiscard ? '¿Seguro? Se pierde el tiempo' : 'Descartar',
  ) as HTMLButtonElement
  discard.type = 'button'
  discard.addEventListener('click', () => {
    if (draft.confirmingDiscard) actions.discard(timer)
    else actions.confirmDiscard()
  })

  const cancel = element('button', 'ghost-button', 'Cancelar') as HTMLButtonElement
  cancel.type = 'button'
  cancel.addEventListener('click', () => actions.cancel())

  const save = element('button', 'primary-button', 'Guardar') as HTMLButtonElement
  save.type = 'button'
  save.addEventListener('click', () => actions.save(timer))

  const row = element('div', 'edit-actions')
  row.append(discard, element('span', 'spacer'), cancel, save)
  form.append(row)
  return form
}
