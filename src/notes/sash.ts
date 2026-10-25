export interface SashSpec {
  handle: HTMLElement
  root: HTMLElement
  variable: '--rail-open' | '--aside-open' | '--questions-open' | '--transcript-open'
  side: 'left' | 'right'
  storageKey: string
  initial: number
  min: number
  max: number
  readerMin: number
  otherWidth: () => number
}

const KEY_STEP = 16

export function clampWidth(
  wanted: number,
  spec: Pick<SashSpec, 'min' | 'max' | 'readerMin'>,
  viewport: number,
  other: number,
): number {
  const roomLeft = viewport - other - spec.readerMin
  const ceiling = Math.max(spec.min, Math.min(spec.max, roomLeft))
  return Math.round(Math.min(ceiling, Math.max(spec.min, wanted)))
}

function stored(key: string): number | null {
  try {
    const value = Number(window.localStorage.getItem(key))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

function store(key: string, width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, String(width))
  } catch {
    return
  }
}

export function attachSash(spec: SashSpec): void {
  let width = stored(spec.storageKey) ?? spec.initial

  const apply = (next: number): void => {
    width = clampWidth(next, spec, spec.root.clientWidth || window.innerWidth, spec.otherWidth())
    spec.root.style.setProperty(spec.variable, `${width}px`)
    spec.handle.setAttribute('aria-valuenow', String(width))
  }

  spec.handle.setAttribute('aria-valuemin', String(spec.min))
  spec.handle.setAttribute('aria-valuemax', String(spec.max))
  apply(width)

  spec.handle.addEventListener('pointerdown', (event: PointerEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    spec.handle.setPointerCapture(event.pointerId)
    spec.handle.classList.add('sash--dragging')
    document.body.classList.add('resizing')

    const move = (moved: PointerEvent): void => {
      const bounds = spec.root.getBoundingClientRect()
      apply(spec.side === 'left' ? moved.clientX - bounds.left : bounds.right - moved.clientX)
    }
    const end = (): void => {
      spec.handle.removeEventListener('pointermove', move)
      spec.handle.removeEventListener('pointerup', end)
      spec.handle.removeEventListener('pointercancel', end)
      spec.handle.classList.remove('sash--dragging')
      document.body.classList.remove('resizing')
      store(spec.storageKey, width)
    }
    spec.handle.addEventListener('pointermove', move)
    spec.handle.addEventListener('pointerup', end)
    spec.handle.addEventListener('pointercancel', end)
  })

  spec.handle.addEventListener('dblclick', () => {
    apply(spec.initial)
    store(spec.storageKey, null)
  })

  spec.handle.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const grow = (event.key === 'ArrowRight') === (spec.side === 'left')
    apply(width + (grow ? KEY_STEP : -KEY_STEP))
    store(spec.storageKey, width)
  })

  window.addEventListener('resize', () => {
    apply(width)
  })
}
