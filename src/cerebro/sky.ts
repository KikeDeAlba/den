import type Graph from 'graphology'
import type Sigma from 'sigma'
import { SKY } from './palette.ts'
import type { EdgeAttributes, NodeAttributes } from './types.ts'

interface Star {
  u: number
  v: number
  radius: number
  alpha: number
  twinkle: number
  speed: number
  phase: number
  color: string
  depth: number
  flare: boolean
}

interface Layer {
  count: number
  depth: number
  radius: [number, number]
  alpha: [number, number]
  flare: number
}

interface Halo {
  x: number
  y: number
  radius: number
  alpha: number
  color: string
}

interface Cloud {
  x: number
  y: number
  spread: number
  count: number
}

const SEED = 0x5eed
const TWINKLE_FRAME = 1000 / 8
const SPRITE = 64
const FLARE = 32
const FADED_ALPHA = 0.15

const LAYERS: Layer[] = [
  { count: 250, depth: 0.012, radius: [0.3, 0.6], alpha: [0.2, 0.5], flare: 0 },
  { count: 115, depth: 0.03, radius: [0.5, 0.9], alpha: [0.35, 0.7], flare: 0 },
  { count: 35, depth: 0.06, radius: [0.8, 1.4], alpha: [0.7, 1], flare: 0.45 },
]

const STAR_TINTS = ['#f4f7ff', '#f4f7ff', '#f4f7ff', '#dce6ff', '#c9d8ff', '#fff1dc']
const NEBULAE = ['#5b4fc4', '#2f7f99', '#9a4a78', '#3a5cc0', '#7a52b8', '#2f8f7a']

function random(seed: number): () => number {
  let value = seed >>> 0
  return () => {
    value = (value + 0x6d2b79f5) >>> 0
    let mixed = Math.imul(value ^ (value >>> 15), 1 | value)
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }
}

function between(next: () => number, [low, high]: [number, number]): number {
  return low + (high - low) * next()
}

function makeStars(): Star[] {
  const next = random(SEED)
  const stars: Star[] = []
  for (const layer of LAYERS) {
    for (let at = 0; at < layer.count; at += 1) {
      stars.push({
        u: next(),
        v: next(),
        radius: between(next, layer.radius),
        alpha: between(next, layer.alpha),
        twinkle: next() < 0.4 ? 0.25 + next() * 0.45 : 0.08,
        speed: 0.0006 + next() * 0.0016,
        phase: next() * Math.PI * 2,
        color: STAR_TINTS[Math.floor(next() * STAR_TINTS.length)] ?? SKY.star,
        depth: layer.depth,
        flare: next() < layer.flare,
      })
    }
  }
  return stars
}

function hash(text: string): number {
  let value = 2166136261
  for (let at = 0; at < text.length; at += 1) value = Math.imul(value ^ text.charCodeAt(at), 16777619)
  return value >>> 0
}

function rgb(color: string): [number, number, number] {
  const digits = /^#([0-9a-f]{6})$/i.exec(color)?.[1] ?? 'ffffff'
  return [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16)) as [number, number, number]
}

function rgba(color: string, alpha: number): string {
  const [red, green, blue] = rgb(color)
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`
}

function wrap(value: number, size: number): number {
  return ((value % size) + size) % size
}

export function createSky(
  stage: HTMLElement,
  renderer: Sigma<NodeAttributes, EdgeAttributes>,
  graph: Graph<NodeAttributes, EdgeAttributes>,
): void {
  const layerStyle: Partial<CSSStyleDeclaration> = { top: '0', left: '0', pointerEvents: 'none', mixBlendMode: 'screen' }
  const starCanvas = renderer.createCanvas('sky-stars', { beforeLayer: 'stage', style: layerStyle })
  const haloCanvas = renderer.createCanvas('sky-halos', { beforeLayer: 'stage', style: layerStyle })
  const starContext = starCanvas.getContext('2d')
  const haloContext = haloCanvas.getContext('2d')
  if (starContext === null || haloContext === null) return

  const stars = makeStars().sort((left, right) => left.color.localeCompare(right.color))
  const sprites = new Map<string, HTMLCanvasElement>()
  const flares = new Map<string, HTMLCanvasElement>()
  const camera = renderer.getCamera()
  const calm = window.matchMedia('(prefers-reduced-motion: reduce)')
  let width = 0
  let height = 0
  let ratio = 1
  let frame = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  let clock = 0

  const sprite = (color: string): HTMLCanvasElement => {
    const cached = sprites.get(color)
    if (cached !== undefined) return cached
    const canvas = document.createElement('canvas')
    canvas.width = SPRITE
    canvas.height = SPRITE
    const context = canvas.getContext('2d')
    if (context !== null) {
      const half = SPRITE / 2
      const gradient = context.createRadialGradient(half, half, 0, half, half, half)
      gradient.addColorStop(0, rgba(color, 0.9))
      gradient.addColorStop(0.12, rgba(color, 0.55))
      gradient.addColorStop(0.32, rgba(color, 0.18))
      gradient.addColorStop(0.6, rgba(color, 0.05))
      gradient.addColorStop(1, rgba(color, 0))
      context.fillStyle = gradient
      context.fillRect(0, 0, SPRITE, SPRITE)
    }
    sprites.set(color, canvas)
    return canvas
  }

  const flare = (color: string): HTMLCanvasElement => {
    const cached = flares.get(color)
    if (cached !== undefined) return cached
    const canvas = document.createElement('canvas')
    canvas.width = FLARE
    canvas.height = FLARE
    const context = canvas.getContext('2d')
    if (context !== null) {
      const half = FLARE / 2
      const gradient = context.createRadialGradient(half, half, 0, half, half, half)
      gradient.addColorStop(0, rgba(color, 0.35))
      gradient.addColorStop(1, rgba(color, 0))
      context.fillStyle = gradient
      context.fillRect(0, 0, FLARE, FLARE)
    }
    flares.set(color, canvas)
    return canvas
  }

  const drawStars = (time: number) => {
    starContext.setTransform(ratio, 0, 0, ratio, 0, 0)
    starContext.clearRect(0, 0, width, height)
    if (width === 0 || height === 0) return
    const view = camera.getState()
    const span = Math.max(width, height) / Math.sqrt(view.ratio)
    for (const star of stars) {
      const x = wrap(star.u * width - view.x * span * star.depth * 10, width)
      const y = wrap(star.v * height + view.y * span * star.depth * 10, height)
      const shimmer = time === 0 ? 1 : 1 - star.twinkle * (0.5 + 0.5 * Math.sin(time * star.speed + star.phase))
      const alpha = star.alpha * shimmer
      starContext.globalAlpha = alpha
      if (star.flare) {
        const reach = star.radius * 5
        starContext.drawImage(flare(star.color), x - reach, y - reach, reach * 2, reach * 2)
      }
      if (starContext.fillStyle !== star.color) starContext.fillStyle = star.color
      starContext.beginPath()
      starContext.arc(x, y, star.radius, 0, Math.PI * 2)
      starContext.fill()
    }
    starContext.globalAlpha = 1
  }

  const drawHalos = () => {
    haloContext.setTransform(ratio, 0, 0, ratio, 0, 0)
    haloContext.clearRect(0, 0, width, height)
    if (width === 0 || height === 0) return
    const halos: Halo[] = []
    const clouds = new Map<string, Cloud>()
    graph.forEachNode((node, attributes) => {
      const display = renderer.getNodeDisplayData(node)
      if (display === undefined || display.visibility === 'hidden') return
      const glow = Math.max(0, Math.min(1, attributes.glow))
      if (glow === 0) return
      const point = renderer.framedGraphToViewport(display)
      const core = renderer.scaleSize(display.size)
      const radius = core * 6 + 10
      const faded = display.color === SKY.faded
      const cloud = clouds.get(attributes.project) ?? { x: 0, y: 0, spread: 0, count: 0 }
      cloud.x += point.x
      cloud.y += point.y
      cloud.spread += point.x * point.x + point.y * point.y
      cloud.count += 1
      clouds.set(attributes.project, cloud)
      if (point.x < -radius || point.y < -radius || point.x > width + radius || point.y > height + radius) return
      halos.push({ x: point.x, y: point.y, radius, alpha: glow * (faded ? FADED_ALPHA : 1), color: attributes.color })
    })

    for (const [project, cloud] of clouds) {
      if (cloud.count < 3) continue
      const x = cloud.x / cloud.count
      const y = cloud.y / cloud.count
      const spread = Math.sqrt(Math.max(0, cloud.spread / cloud.count - x * x - y * y))
      const radius = Math.min(Math.max(140, spread * 1.8), Math.max(width, height) * 0.6)
      const tint = NEBULAE[hash(project) % NEBULAE.length] ?? NEBULAE[0] ?? SKY.top
      const gradient = haloContext.createRadialGradient(x, y, 0, x, y, radius)
      gradient.addColorStop(0, rgba(tint, 0.22))
      gradient.addColorStop(0.5, rgba(tint, 0.09))
      gradient.addColorStop(1, rgba(tint, 0))
      haloContext.fillStyle = gradient
      haloContext.fillRect(x - radius, y - radius, radius * 2, radius * 2)
    }

    haloContext.globalCompositeOperation = 'lighter'
    for (const halo of halos) {
      haloContext.globalAlpha = halo.alpha
      haloContext.drawImage(sprite(halo.color), halo.x - halo.radius, halo.y - halo.radius, halo.radius * 2, halo.radius * 2)
    }
    haloContext.globalAlpha = 1
    haloContext.globalCompositeOperation = 'source-over'
  }

  const twinkling = () => !calm.matches && !document.hidden && document.hasFocus()

  const paint = () => {
    frame = 0
    drawStars(calm.matches ? 0 : clock)
  }

  const wake = () => {
    if (frame === 0) frame = requestAnimationFrame(paint)
  }

  const beat = () => {
    timer = null
    if (!twinkling()) return
    clock = performance.now()
    wake()
    timer = setTimeout(beat, TWINKLE_FRAME)
  }

  const twinkle = () => {
    if (timer === null && twinkling()) beat()
  }

  const watchRatio = () => {
    window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
      'change',
      () => {
        resize()
        watchRatio()
      },
      { once: true },
    )
  }

  const resize = () => {
    const nextWidth = stage.clientWidth
    const nextHeight = stage.clientHeight
    const nextRatio = window.devicePixelRatio || 1
    if (nextWidth === width && nextHeight === height && nextRatio === ratio) return
    width = nextWidth
    height = nextHeight
    ratio = nextRatio
    for (const canvas of [starCanvas, haloCanvas]) {
      canvas.width = Math.max(1, Math.round(width * ratio))
      canvas.height = Math.max(1, Math.round(height * ratio))
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }
    drawHalos()
    wake()
  }

  new ResizeObserver(resize).observe(stage)
  renderer.on('resize', resize)
  renderer.on('afterRender', drawHalos)
  camera.on('updated', wake)
  calm.addEventListener('change', () => {
    wake()
    twinkle()
  })
  document.addEventListener('visibilitychange', twinkle)
  window.addEventListener('focus', twinkle)
  watchRatio()
  resize()
  twinkle()
}
