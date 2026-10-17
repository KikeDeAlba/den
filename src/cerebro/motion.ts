import type Graph from 'graphology'
import type Sigma from 'sigma'
import type { EdgeAttributes, NodeAttributes } from './types.ts'

type BrainGraph = Graph<NodeAttributes, EdgeAttributes>
type BrainRenderer = Sigma<NodeAttributes, EdgeAttributes>

const DRAG_THRESHOLD = 4
const FLOAT_FRAME = 1000 / 30
const FLOAT_MAX_NODES = 1500
const FLOAT_AMPLITUDE = 0.006
const FLOAT_MIN_PERIOD = 6000
const FLOAT_MAX_PERIOD = 12000
const FLOAT_FOCUS_FACTOR = 0.3
const FLOAT_EASE = 0.08
const FLOAT_RAMP = 1500
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
}

export interface DragControl {
  dragging(): string | null
  consumeDrag(): boolean
  cancel(): void
}

export function bindDrag(renderer: BrainRenderer, graph: BrainGraph, stage: HTMLElement, hooks: DragHooks): DragControl {
  let node: string | null = null
  let origin = { x: 0, y: 0 }
  let moved = false
  let dragged = false

  const finish = (notify: boolean): void => {
    if (node === null) return
    const released = node
    const wasMoved = moved
    node = null
    moved = false
    stage.classList.remove('brain-stage--grabbing')
    if (!wasMoved) return
    dragged = true
    if (notify) hooks.onRelease(released)
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
    cancel: () => {
      finish(false)
      dragged = false
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
  }
}

function graphRadius(graph: BrainGraph): number {
  if (graph.order === 0) return 0
  let sumX = 0
  let sumY = 0
  graph.forEachNode((_node, attributes) => {
    sumX += attributes.baseX
    sumY += attributes.baseY
  })
  const centerX = sumX / graph.order
  const centerY = sumY / graph.order
  let radius = 0
  graph.forEachNode((_node, attributes) => {
    radius = Math.max(radius, Math.hypot(attributes.baseX - centerX, attributes.baseY - centerY))
  })
  return radius
}

export function startFloat(graph: BrainGraph, options: FloatOptions): FloatControl {
  const waves = new Map<string, Wave>()
  let layoutActive = false
  let frame: number | null = null
  let last = 0
  let resumedAt = 0
  let radius = 0
  let floating = false

  const enabled = (): boolean => !reducedMotion.matches && graph.order > 0 && graph.order <= FLOAT_MAX_NODES

  const paused = (): boolean => layoutActive || document.hidden || options.dragging() !== null

  const settle = (): void => {
    if (!floating) return
    floating = false
    graph.updateEachNodeAttributes(
      (_node, attributes) => {
        attributes.x = attributes.baseX
        attributes.y = attributes.baseY
        return attributes
      },
      { attributes: ['x', 'y'] },
    )
  }

  const step = (now: number): void => {
    frame = null
    if (!enabled()) {
      settle()
      return
    }
    frame = requestAnimationFrame(step)
    if (paused()) {
      floating = false
      resumedAt = 0
      return
    }
    if (now - last < FLOAT_FRAME) return
    last = now
    if (resumedAt === 0) {
      resumedAt = now
      radius = graphRadius(graph)
      for (const wave of waves.values()) wave.factor = 0
    }
    const ramp = Math.min(1, (now - resumedAt) / FLOAT_RAMP)
    const amplitude = radius * FLOAT_AMPLITUDE * (ramp * ramp * (3 - 2 * ramp))
    const { focus, neighbors } = options.focus()
    floating = true
    graph.updateEachNodeAttributes(
      (node, attributes) => {
        let wave = waves.get(node)
        if (wave === undefined) {
          wave = waveFor(node)
          wave.factor = 0
          waves.set(node, wave)
        }
        const target = node === focus || neighbors.has(node) ? FLOAT_FOCUS_FACTOR : 1
        wave.factor += (target - wave.factor) * FLOAT_EASE
        const reach = amplitude * wave.factor
        attributes.x = attributes.baseX + Math.sin(now * wave.speedX + wave.phaseX) * reach
        attributes.y = attributes.baseY + Math.sin(now * wave.speedY + wave.phaseY) * reach
        return attributes
      },
      { attributes: ['x', 'y'] },
    )
  }

  const wake = (): void => {
    if (frame === null && enabled()) frame = requestAnimationFrame(step)
  }

  reducedMotion.addEventListener('change', () => {
    if (reducedMotion.matches) {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      settle()
    } else {
      wake()
    }
  })

  document.addEventListener('visibilitychange', wake)

  return {
    setLayoutActive: (active) => {
      layoutActive = active
      if (active) floating = false
      wake()
    },
    reset: () => {
      waves.clear()
      floating = false
      resumedAt = 0
      wake()
    },
  }
}

export function appear(graph: BrainGraph): () => void {
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
  }
}
