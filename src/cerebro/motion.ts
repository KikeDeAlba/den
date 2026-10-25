import type Graph from 'graphology'
import type Sigma from 'sigma'
import type { EdgeAttributes, NodeAttributes } from './types.ts'

type BrainGraph = Graph<NodeAttributes, EdgeAttributes>
type BrainRenderer = Sigma<NodeAttributes, EdgeAttributes>

const DRAG_THRESHOLD = 4
const RELEASE_SLACK = 50
const FLOAT_FRAME = 1000 / 15
const FLOAT_MAX_NODES = 1500
const FLOAT_AMPLITUDE_PX = 2.9
const FLOAT_MIN_PERIOD = 16000
const FLOAT_MAX_PERIOD = 28000
const FLOAT_NEIGHBOR_FACTOR = 0.3
const FLOAT_EASE_TIME = 50
const FLOAT_MIN_STEP_PX = 0.25
const FLOAT_RAMP = 1500
const FLOAT_FADE = 2500
const FLOAT_IDLE = 30000
const APPEAR_TOTAL = 600
const APPEAR_FADE = 220

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)')

export function prefersReducedMotion(): boolean {
  return reducedMotion.matches
}

export interface DragHooks {
  onStart(node: string): void
  onMove(node: string, x: number, y: number): void
  onRelease(node: string): void
  onCancel(node: string): void
}

export interface DragControl {
  dragging(): string | null
  consumeDrag(): boolean
  releasedRecently(): boolean
  cancel(): void
}

export function bindDrag(renderer: BrainRenderer, graph: BrainGraph, stage: HTMLElement, hooks: DragHooks): DragControl {
  let node: string | null = null
  let origin = { x: 0, y: 0 }
  let moved = false
  let dragged = false
  let releasedAt = Number.NEGATIVE_INFINITY

  const finish = (notify: boolean): void => {
    if (node === null) return
    const released = node
    const wasMoved = moved
    node = null
    moved = false
    stage.classList.remove('brain-stage--grabbing')
    if (!wasMoved) return
    dragged = true
    if (notify) {
      releasedAt = performance.now()
      hooks.onRelease(released)
    } else {
      hooks.onCancel(released)
    }
  }

  renderer.on('downNode', ({ node: hit, event }) => {
    if (event.original instanceof MouseEvent && event.original.button !== 0) return
    node = hit
    origin = { x: event.x, y: event.y }
    moved = false
    dragged = false
  })

  renderer.on('downStage', () => {
    dragged = false
  })

  renderer.on('moveBody', ({ event }) => {
    if (node === null || !graph.hasNode(node)) return
    event.preventSigmaDefault()
    if (event.original.cancelable) event.original.preventDefault()
    event.original.stopPropagation()
    if (!moved) {
      if (Math.hypot(event.x - origin.x, event.y - origin.y) < DRAG_THRESHOLD) return
      moved = true
      if (renderer.getCustomBBox() === null) renderer.setCustomBBox(renderer.getBBox())
      stage.classList.add('brain-stage--grabbing')
      hooks.onStart(node)
    }
    const point = renderer.viewportToGraph(event)
    graph.mergeNodeAttributes(node, { x: point.x, y: point.y, baseX: point.x, baseY: point.y })
    hooks.onMove(node, point.x, point.y)
  })

  renderer.on('upNode', () => finish(true))
  renderer.on('upStage', () => finish(true))

  return {
    dragging: () => (moved ? node : null),
    consumeDrag: () => {
      const was = dragged
      dragged = false
      return was
    },
    releasedRecently: () => performance.now() - releasedAt <= renderer.getSetting('doubleClickTimeout') + RELEASE_SLACK,
    cancel: () => {
      finish(false)
      dragged = false
      releasedAt = Number.NEGATIVE_INFINITY
      renderer.setCustomBBox(null)
    },
  }
}

export interface FloatFocus {
  focus: string | null
  neighbors: ReadonlySet<string>
}

export interface FloatOptions {
  focus: () => FloatFocus
  dragging: () => string | null
  renderer: BrainRenderer
  signal: AbortSignal
}

export interface FloatControl {
  setLayoutActive(active: boolean): void
  reset(): void
}

interface Wave {
  phaseX: number
  phaseY: number
  speedX: number
  speedY: number
  factor: number
  offsetX: number
  offsetY: number
}

function hash(text: string, seed: number): number {
  let value = 2166136261 ^ seed
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0) / 4294967296
}

function period(unit: number): number {
  return (Math.PI * 2) / (FLOAT_MIN_PERIOD + unit * (FLOAT_MAX_PERIOD - FLOAT_MIN_PERIOD))
}

function waveFor(node: string): Wave {
  return {
    phaseX: hash(node, 1) * Math.PI * 2,
    phaseY: hash(node, 2) * Math.PI * 2,
    speedX: period(hash(node, 3)),
    speedY: period(hash(node, 4)),
    factor: 1,
    offsetX: 0,
    offsetY: 0,
  }
}

export function startFloat(graph: BrainGraph, options: FloatOptions): FloatControl {
  const waves = new Map<string, Wave>()
  let layoutActive = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let last = 0
  let energy = 0
  let unit = 0
  let pressed = false
  let displaced = false
  let stale = true
  let activeAt = performance.now()
  const renderer = options.renderer

  const measure = (): void => {
    const origin = renderer.viewportToGraph({ x: 0, y: 0 })
    const offset = renderer.viewportToGraph({ x: 1, y: 0 })
    unit = Math.hypot(offset.x - origin.x, offset.y - origin.y)
    stale = true
  }

  const enabled = (): boolean =>
    !reducedMotion.matches && graph.order > 0 && graph.order <= FLOAT_MAX_NODES

  const halted = (): boolean => layoutActive || pressed || document.hidden || options.dragging() !== null

  const resting = (now: number): boolean => !document.hasFocus() || now - activeAt > FLOAT_IDLE

  const stop = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const settle = (): void => {
    energy = 0
    last = 0
    if (!displaced) return
    displaced = false
    for (const wave of waves.values()) {
      wave.offsetX = 0
      wave.offsetY = 0
    }
    graph.updateEachNodeAttributes(
      (_node, attributes) => {
        attributes.x = attributes.baseX
        attributes.y = attributes.baseY
        return attributes
      },
      { attributes: ['x', 'y'] },
    )
  }

  const step = (): void => {
    timer = null
    if (!enabled() || halted()) {
      settle()
      return
    }
    const now = performance.now()
    if (last === 0) measure()
    const elapsed = last === 0 ? 0 : now - last
    last = now
    const rest = resting(now)
    energy = rest ? Math.max(0, energy - elapsed / FLOAT_FADE) : Math.min(1, energy + elapsed / FLOAT_RAMP)
    if (rest && energy === 0) {
      settle()
      return
    }
    const amplitude = (FLOAT_AMPLITUDE_PX * (energy * energy * (3 - 2 * energy))) / Math.SQRT2
    const ease = elapsed === 0 ? 1 : 1 - Math.exp(-elapsed / FLOAT_EASE_TIME)
    const { focus, neighbors } = options.focus()
    const offsets = new Map<string, { x: number; y: number }>()
    let shift = 0
    graph.forEachNode((node) => {
      let wave = waves.get(node)
      if (wave === undefined) {
        wave = waveFor(node)
        waves.set(node, wave)
      }
      const target = node === focus ? 0 : neighbors.has(node) ? FLOAT_NEIGHBOR_FACTOR : 1
      wave.factor = Math.abs(target - wave.factor) < 0.05 ? target : wave.factor + (target - wave.factor) * ease
      const reach = amplitude * wave.factor
      const x = Math.sin(now * wave.speedX + wave.phaseX) * reach
      const y = Math.sin(now * wave.speedY + wave.phaseY) * reach
      offsets.set(node, { x, y })
      const parked = reach === 0 && (wave.offsetX !== 0 || wave.offsetY !== 0)
      shift = parked ? Number.POSITIVE_INFINITY : Math.max(shift, Math.abs(x - wave.offsetX), Math.abs(y - wave.offsetY))
    })
    if (stale || shift >= FLOAT_MIN_STEP_PX) {
      stale = false
      displaced = true
      graph.updateEachNodeAttributes(
        (node, attributes) => {
          const wave = waves.get(node)
          const offset = offsets.get(node)
          if (wave === undefined || offset === undefined) return attributes
          wave.offsetX = offset.x
          wave.offsetY = offset.y
          attributes.x = attributes.baseX + offset.x * unit
          attributes.y = attributes.baseY + offset.y * unit
          return attributes
        },
        { attributes: ['x', 'y'] },
      )
    }
    timer = setTimeout(step, FLOAT_FRAME)
  }

  const wake = (): void => {
    if (timer === null && enabled() && !halted()) timer = setTimeout(step, 0)
  }

  const stir = (): void => {
    activeAt = performance.now()
    wake()
  }

  const signal = options.signal
  reducedMotion.addEventListener(
    'change',
    () => {
      stop()
      if (reducedMotion.matches) settle()
      else wake()
    },
    { signal },
  )

  for (const type of ['pointermove', 'pointerdown', 'wheel', 'keydown', 'focus']) {
    window.addEventListener(type, stir, { passive: true, signal })
  }
  window.addEventListener('blur', wake, { signal })
  document.addEventListener('visibilitychange', wake, { signal })

  const release = (): void => {
    if (!pressed) return
    pressed = false
    wake()
  }
  renderer.getContainer().addEventListener(
    'pointerdown',
    () => {
      pressed = true
      stop()
      settle()
    },
    { signal },
  )
  window.addEventListener('pointerup', release, { signal })
  window.addEventListener('pointercancel', release, { signal })
  window.addEventListener('contextmenu', release, { signal })
  renderer.getContainer().addEventListener('lostpointercapture', release, { signal })
  window.addEventListener('blur', release, { signal })
  signal.addEventListener('abort', stop)
  renderer.getCamera().on('updated', measure)
  renderer.on('resize', measure)

  return {
    setLayoutActive: (active) => {
      layoutActive = active
      if (active) {
        stop()
        settle()
      } else {
        wake()
      }
    },
    reset: () => {
      stop()
      waves.clear()
      stale = true
      displaced = false
      energy = 0
      last = 0
      wake()
    },
  }
}

export function appear(graph: BrainGraph, onFrame: () => void): () => void {
  const order = graph.nodes()
  if (reducedMotion.matches || order.length === 0) return () => {}
  const delays = new Map(order.map((node, index) => [node, (index / Math.max(1, order.length - 1)) * (APPEAR_TOTAL - APPEAR_FADE)]))
  let frame: number | null = null
  let started = 0

  const paint = (elapsed: number): boolean => {
    let pending = false
    graph.updateEachNodeAttributes(
      (node, attributes) => {
        const delay = delays.get(node) ?? 0
        const progress = Math.max(0, Math.min(1, (elapsed - delay) / APPEAR_FADE))
        if (progress < 1) pending = true
        attributes.glow = progress
        return attributes
      },
      { attributes: ['glow'] },
    )
    onFrame()
    return pending
  }

  const step = (now: number): void => {
    if (started === 0) started = now
    frame = paint(now - started) ? requestAnimationFrame(step) : null
  }

  graph.forEachNode((_node, attributes) => {
    attributes.glow = 0
  })
  frame = requestAnimationFrame(step)

  return () => {
    if (frame === null) return
    cancelAnimationFrame(frame)
    frame = null
    graph.updateEachNodeAttributes(
      (_node, attributes) => {
        attributes.glow = 1
        return attributes
      },
      { attributes: ['glow'] },
    )
    onFrame()
  }
}
