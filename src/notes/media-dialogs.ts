import './media-dialogs.css'
import {
  describeProblem,
  meetingCompress,
  meetingStripVideo,
  type CompressPreset,
  type MeetingMediaChange,
  type MeetingRecord,
} from '../bita.ts'
import { element, icon } from '../dom.ts'

interface PresetSpec {
  id: CompressPreset
  name: string
  spec: string
  videoKbps: number
  blur: string
}

export const PRESETS: PresetSpec[] = [
  { id: 'light', name: 'Ligera', spec: '1280 px · 2 fps', videoKbps: 250, blur: '0px' },
  { id: 'medium', name: 'Media', spec: '960 px · 1 fps', videoKbps: 140, blur: '0.6px' },
  { id: 'max', name: 'Máxima', spec: '720 px · 0.5 fps', videoKbps: 70, blur: '1.3px' },
]

const AUDIO_KBPS = 160

const jobs = new Set<string>()
const listeners = new Set<() => void>()
const outcomeWatchers = new Map<string, (change: MeetingMediaChange) => void>()

export function mediaChanged(change: MeetingMediaChange): void {
  jobs.delete(change.id)
  outcomeWatchers.get(change.id)?.(change)
  notify()
}

function notify(): void {
  for (const listener of [...listeners]) listener()
}

export function isCompressing(id: string): boolean {
  return jobs.has(id)
}

export function onMediaJobs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function startCompression(record: MeetingRecord, preset: CompressPreset, prune: boolean): Promise<void> {
  jobs.add(record.id)
  notify()
  return meetingCompress(record.id, preset, prune).catch((error: unknown) => {
    jobs.delete(record.id)
    notify()
    throw error
  })
}

export function formatBytes(bytes: number): string {
  const value = Math.max(0, bytes)
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)} GB`
  if (value >= 1e7) return `${Math.round(value / 1e6)} MB`
  if (value >= 1e5) return `${(value / 1e6).toFixed(1)} MB`
  if (value >= 1e3) return `${Math.round(value / 1e3)} KB`
  return `${Math.round(value)} B`
}

export function estimateCompressed(record: MeetingRecord, preset: CompressPreset): number {
  const spec = PRESETS.find((candidate) => candidate.id === preset) ?? PRESETS[1]
  const seconds = record.durationSeconds ?? 0
  return Math.round((seconds * ((spec?.videoKbps ?? 140) + AUDIO_KBPS) * 1000) / 8)
}

export function estimateAudio(record: MeetingRecord): number {
  return Math.min(record.storage.recordingBytes, Math.round(((record.durationSeconds ?? 0) * AUDIO_KBPS * 1000) / 8))
}

function minutes(record: MeetingRecord): string {
  const seconds = record.durationSeconds ?? 0
  if (seconds < 60) return `${seconds} s`
  return `${Math.round(seconds / 60)} min`
}

function dayLabel(record: MeetingRecord): string {
  const iso = record.startedAt ?? record.createdAt
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10)
  return date.toLocaleDateString('es-MX', { weekday: 'short', day: '2-digit', month: 'short' }).replace(/\./g, '')
}

function fileName(path: string | null | undefined): string {
  if (path === null || path === undefined) return 'recording.mov'
  return path.split('/').pop() ?? path
}

export interface Modal {
  dialog: HTMLElement
  close: () => void
  isOpen: () => boolean
}

export function openModal(labelId: string, width: 'narrow' | 'wide', onClose?: () => void): Modal {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const overlay = element('div', 'mdlg-overlay')
  const dialog = element('section', width === 'wide' ? 'mdlg-dialog mdlg-dialog--wide' : 'mdlg-dialog')
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-labelledby', labelId)
  overlay.append(dialog)
  let open = true

  const close = (): void => {
    if (!open) return
    open = false
    window.removeEventListener('keydown', onKey, true)
    overlay.remove()
    previous?.focus()
    onClose?.()
  }

  const onKey = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      return
    }
    if (event.key === 'Tab') {
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select, textarea')]
      const first = focusable[0]
      const last = focusable.at(-1)
      if (first === undefined || last === undefined) return
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
  }

  overlay.addEventListener('mousedown', (event) => {
    if (event.target === overlay) close()
  })
  window.addEventListener('keydown', onKey, true)
  document.body.append(overlay)
  return { dialog, close, isOpen: () => open }
}

function focusFirst(dialog: HTMLElement): void {
  const target =
    dialog.querySelector<HTMLElement>('[data-autofocus]') ??
    dialog.querySelector<HTMLElement>('button:not([disabled]), input:not([disabled])')
  target?.focus()
}

function head(id: string, glyph: Parameters<typeof icon>[0], tone: 'blue' | 'danger', title: string, subtitle: string): HTMLElement {
  const block = element('div', 'mdlg-head')
  const badge = element('span', `mdlg-badge mdlg-badge--${tone}`)
  badge.append(icon(glyph, 17))
  const heading = element('h2', 'mdlg-title', title)
  heading.id = id
  block.append(badge, heading, element('p', 'mdlg-subtitle', subtitle))
  return block
}

export function button(label: string, className: string, onClick: () => void): HTMLButtonElement {
  const node = document.createElement('button')
  node.type = 'button'
  node.className = className
  node.textContent = label
  node.addEventListener('click', onClick)
  return node
}

function checkRow(title: string, note: string, size: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
  const label = element('label', 'mdlg-check')
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.checked = checked
  input.addEventListener('change', () => onChange(input.checked))
  const text = element('span', 'mdlg-check-text')
  text.append(element('span', 'mdlg-check-title', title), element('span', 'v2-kbd', note))
  label.append(input, text, element('span', 'mdlg-mono', size))
  return label
}

function freedBox(amount: string, note: string): HTMLElement {
  const box = element('div', 'mdlg-freed')
  box.append(element('span', 'mdlg-freed-label', 'Se liberan'), element('span', 'mdlg-freed-figure', amount), element('span', 'v2-kbd', note))
  return box
}

function errorLine(message: string): HTMLElement {
  const line = element('p', 'mdlg-error')
  line.append(icon('warning', 13), element('span', '', message))
  return line
}

function shot(frameSrc: string | null, blur: string, alt: string): HTMLElement {
  const box = element('div', 'mdlg-shot')
  if (frameSrc !== null) {
    const image = document.createElement('img')
    image.src = frameSrc
    image.alt = alt
    image.style.filter = `blur(${blur})`
    box.append(image)
    return box
  }
  const page = element('div', 'mdlg-shot-page')
  page.style.filter = `blur(${blur})`
  page.append(element('span', 'mdlg-shot-line mdlg-shot-line--title'), element('span', 'mdlg-shot-line'), element('span', 'mdlg-shot-line mdlg-shot-line--short'))
  box.append(page)
  return box
}

export function openCompressDialog(
  record: MeetingRecord,
  options: { frameSrc: string | null; beforeReplace: () => void },
): void {
  let preset: CompressPreset = 'medium'
  const intermediate = record.storage.intermediateBytes
  let prune = intermediate > 0
  let phase: 'pick' | 'running' | 'done' | 'failed' = isCompressing(record.id) ? 'running' : 'pick'
  let message = ''
  let result: MeetingRecord | null = null

  const modal = openModal('mdlg-compress-title', 'wide', () => {
    outcomeWatchers.delete(record.id)
  })

  outcomeWatchers.set(record.id, (change) => {
    if (!modal.isOpen()) return
    if (change.ok) {
      phase = 'done'
      result = change.record
    } else {
      phase = 'failed'
      message = change.error ?? 'recap no pudo comprimir el video.'
    }
    paint()
  })

  const original = record.storage.recordingBytes

  const paint = (): void => {
    const spec = PRESETS.find((candidate) => candidate.id === preset) ?? PRESETS[1]
    const estimate = estimateCompressed(record, preset)
    const freed = Math.max(0, original - estimate) + (prune ? intermediate : 0)
    const nodes: HTMLElement[] = [
      head('mdlg-compress-title', 'compress', 'blue', 'Comprimir el video', `${record.title} · ${minutes(record)} · el video se conserva con menos calidad`),
    ]

    if (phase === 'running' || phase === 'done') {
      const status = element('div', 'mdlg-progress')
      if (phase === 'running') {
        status.append(element('span', 'mdlg-progress-title', 'Comprimiendo…'))
        const track = element('div', 'mdlg-progress-track')
        track.append(element('span', 'mdlg-progress-fill'))
        status.append(track)
        status.append(element('p', 'mdlg-note', 'Sigue en segundo plano aunque cierres esta ventana. El original se reemplaza solo cuando el nuevo archivo se verifica completo.'))
      } else {
        status.append(element('span', 'mdlg-progress-title mdlg-progress-title--ok', 'Listo'))
        const now = result?.storage.recordingBytes
        status.append(
          element('p', 'mdlg-note', now === undefined ? 'El video ya quedó comprimido.' : `El video ahora pesa ${formatBytes(now)} (antes ${formatBytes(original)}).`),
        )
      }
      nodes.push(status)
      const actions = element('div', 'mdlg-actions')
      const close = button('Cerrar', 'v2-btn v2-btn--lg', modal.close)
      close.dataset['autofocus'] = ''
      actions.append(close)
      nodes.push(actions)
      modal.dialog.replaceChildren(...nodes)
      return
    }

    const group = element('div', 'mdlg-presets')
    group.setAttribute('role', 'radiogroup')
    group.setAttribute('aria-label', 'Nivel de compresión')
    for (const candidate of PRESETS) {
      const on = candidate.id === preset
      const option = document.createElement('button')
      option.type = 'button'
      option.className = on ? 'mdlg-preset mdlg-preset--on' : 'mdlg-preset'
      option.setAttribute('role', 'radio')
      option.setAttribute('aria-checked', String(on))
      option.append(
        element('span', 'mdlg-preset-name', candidate.name),
        element('span', 'v2-kbd', candidate.spec),
        element('span', 'mdlg-preset-size', `≈ ${formatBytes(estimateCompressed(record, candidate.id))}`),
      )
      option.addEventListener('click', () => {
        preset = candidate.id
        paint()
        modal.dialog.querySelector<HTMLElement>('.mdlg-preset--on')?.focus()
      })
      group.append(option)
    }
    nodes.push(group)

    const previews = element('div', 'mdlg-previews')
    const before = element('figure', 'mdlg-figure')
    before.append(shot(options.frameSrc, '0px', 'Captura original'), element('figcaption', 'v2-kbd', `Original · ${formatBytes(original)}`))
    const after = element('figure', 'mdlg-figure')
    after.append(
      shot(options.frameSrc, spec?.blur ?? '0px', 'Vista previa comprimida'),
      element('figcaption', 'v2-kbd', `Vista previa · ${spec?.spec ?? ''} · ≈ ${formatBytes(estimate)}`),
    )
    previews.append(before, after)
    nodes.push(previews)

    if (intermediate > 0) {
      const wrap = element('div', 'mdlg-pad')
      wrap.append(
        checkRow('Borrar también los WAV intermedios', 'solo sirven para volver a transcribir', formatBytes(intermediate), prune, (value) => {
          prune = value
          paint()
        }),
      )
      nodes.push(wrap)
    }

    nodes.push(freedBox(`≈ ${formatBytes(freed)}`, 'audio, capturas, transcripción y minuta no se tocan'))
    nodes.push(
      element(
        'p',
        'mdlg-note mdlg-pad',
        'Se comprime en segundo plano y el original se reemplaza solo cuando el nuevo archivo se verifica completo. Puedes seguir usando Den mientras tanto.',
      ),
    )
    if (phase === 'failed') nodes.push(errorLine(message))

    const actions = element('div', 'mdlg-actions')
    const cancel = button('Cancelar', 'v2-btn v2-btn--lg', modal.close)
    const go = button(`Comprimir a ≈ ${formatBytes(estimate)}`, 'v2-btn v2-btn--lg v2-btn--blue', () => {
      options.beforeReplace()
      phase = 'running'
      paint()
      startCompression(record, preset, prune).catch((error: unknown) => {
        phase = 'failed'
        message = describeProblem(error).message
        if (modal.isOpen()) paint()
      })
    })
    actions.append(cancel, go)
    nodes.push(actions)
    modal.dialog.replaceChildren(...nodes)
  }

  paint()
  focusFirst(modal.dialog)
}

export function openStripDialog(
  record: MeetingRecord,
  options: { beforeReplace: () => void; onDone: (record: MeetingRecord) => void },
): void {
  const intermediate = record.storage.intermediateBytes
  let prune = intermediate > 0
  let busy = false
  let message = ''
  const audio = estimateAudio(record)
  const video = Math.max(0, record.storage.recordingBytes - audio)
  const modal = openModal('mdlg-strip-title', 'narrow')

  const item = (
    glyph: Parameters<typeof icon>[0],
    tone: 'danger' | 'ok',
    title: string,
    note: string,
    size: string,
    tag: string,
  ): HTMLElement => {
    const row = element('div', 'mdlg-item')
    const badge = element('span', `mdlg-item-icon mdlg-item-icon--${tone}`)
    badge.append(icon(glyph, 12))
    const text = element('span', 'mdlg-item-text')
    text.append(element('span', 'mdlg-item-title', title), element('span', 'v2-kbd', note))
    const right = element('span', 'mdlg-item-right')
    right.append(element('span', 'mdlg-mono', size), element('span', `mdlg-tag mdlg-tag--${tone}`, tag))
    row.append(badge, text, right)
    return row
  }

  const paint = (): void => {
    const freed = video + (prune ? intermediate : 0)
    const total = record.storage.totalBytes
    const nodes: HTMLElement[] = [
      head('mdlg-strip-title', 'trash', 'danger', '¿Borrar el video de esta reunión?', `${record.title} · ${dayLabel(record)} · ${minutes(record)}`),
    ]
    const list = element('div', 'mdlg-items')
    list.append(
      item('screen', 'danger', 'Video de la pantalla', fileName(record.recording), formatBytes(video), 'se borra'),
      item('wave', 'ok', 'Audio de Sala y Remotos', 'se extrae a recording.m4a · 2 pistas AAC', `≈ ${formatBytes(audio)}`, 'se queda'),
      item('image', 'ok', 'Capturas clave', 'siguen cambiando al ritmo del audio', formatBytes(record.storage.framesBytes), 'se quedan'),
      item('doc', 'ok', 'Transcripción y minuta', 'transcript.json · summary.md', formatBytes(record.storage.otherBytes), 'se quedan'),
    )
    if (intermediate > 0) {
      const check = checkRow(
        'Borrar también los WAV intermedios',
        'mic.wav + system.wav · solo sirven para volver a transcribir',
        formatBytes(intermediate),
        prune,
        (value) => {
          prune = value
          paint()
        },
      )
      check.classList.add('mdlg-check--danger')
      list.append(check)
    }
    nodes.push(list)
    nodes.push(freedBox(formatBytes(freed), `de ${formatBytes(total)} · la reunión queda en ${formatBytes(Math.max(0, total - freed))}`))
    nodes.push(element('p', 'mdlg-note mdlg-pad', 'No se puede deshacer. La página sigue igual: el reproductor pasa a modo audio con las capturas.'))
    if (message.length > 0) nodes.push(errorLine(message))

    const actions = element('div', 'mdlg-actions')
    const cancel = button('Cancelar', 'v2-btn v2-btn--lg', modal.close)
    cancel.disabled = busy
    const go = button(busy ? 'Borrando…' : 'Borrar video', 'v2-btn v2-btn--lg v2-btn--danger', () => {
      busy = true
      message = ''
      paint()
      options.beforeReplace()
      meetingStripVideo(record.id, prune)
        .then((updated) => {
          busy = false
          notify()
          modal.close()
          options.onDone(updated)
        })
        .catch((error: unknown) => {
          busy = false
          message = describeProblem(error).message
          if (modal.isOpen()) paint()
        })
    })
    go.disabled = busy
    actions.append(cancel, go)
    nodes.push(actions)
    modal.dialog.replaceChildren(...nodes)
  }

  paint()
  focusFirst(modal.dialog)
}

export function confirmDialog(options: { title: string; body: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false
    const modal = openModal('mdlg-confirm-title', 'narrow', () => {
      if (!answered) resolve(false)
    })
    const danger = options.danger === true
    const nodes: HTMLElement[] = [head('mdlg-confirm-title', danger ? 'trash' : 'check', danger ? 'danger' : 'blue', options.title, options.body)]
    const actions = element('div', 'mdlg-actions')
    const cancel = button('Cancelar', 'v2-btn v2-btn--lg', modal.close)
    cancel.dataset['autofocus'] = ''
    const ok = button(options.confirm, danger ? 'v2-btn v2-btn--lg v2-btn--danger' : 'v2-btn v2-btn--lg v2-btn--blue', () => {
      answered = true
      resolve(true)
      modal.close()
    })
    actions.append(cancel, ok)
    nodes.push(actions)
    modal.dialog.replaceChildren(...nodes)
    focusFirst(modal.dialog)
  })
}
