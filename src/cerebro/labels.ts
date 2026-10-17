import type Graph from 'graphology'
import type Sigma from 'sigma'
import type { EdgeAttributes, NodeAttributes } from './types.ts'

type BrainGraph = Graph<NodeAttributes, EdgeAttributes>
type BrainRenderer = Sigma<NodeAttributes, EdgeAttributes>

export const LABEL_SIZE = 11
export const LABEL_FONT = "'Instrument Sans', -apple-system, system-ui, sans-serif"

const LABEL_MARGIN = 5
const LABEL_PAD = 4
const CELL = 64
const FLOAT_DRIFT = 3

export interface LabelQuery {
  visible(attributes: NodeAttributes): boolean
  focus: string | null
  neighbors: ReadonlySet<string>
}

export interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface Candidate {
  node: string
  rank: number
  weight: number
  x: number
  y: number
  radius: number
}

interface Obstacle extends Box {
  owner: string
}

const widths = new Map<string, number>()
const advances = new Map<string, number>()
let context: CanvasRenderingContext2D | null = null

export function resetLabelMetrics(): void {
  widths.clear()
  advances.clear()
}

function advance(glyph: string): number {
  let width = advances.get(glyph)
  if (width !== undefined) return width
  context ??= document.createElement('canvas').getContext('2d')
  if (context === null) return LABEL_SIZE * 0.6
  context.font = `${LABEL_SIZE}px ${LABEL_FONT}`
  width = context.measureText(glyph).width
  advances.set(glyph, width)
  return width
}

function textWidth(text: string): number {
  let width = widths.get(text)
  if (width !== undefined) return width
  width = 0
  for (const glyph of text) width += advance(glyph)
  widths.set(text, width)
  return width
}

export function labelBox(x: number, y: number, radius: number, text: string): Box {
  const start = x + radius + LABEL_MARGIN
  return {
    minX: start - LABEL_PAD,
    maxX: start + textWidth(text) + LABEL_PAD,
    minY: y - LABEL_SIZE / 2 - LABEL_PAD,
    maxY: y + LABEL_SIZE / 2 + LABEL_PAD,
  }
}

function overlaps(a: Box, b: Box): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY
}

class SpatialGrid {
  private readonly cells = new Map<number, Obstacle[]>()

  private keys(box: Box, visit: (key: number) => boolean | void): boolean {
    const x0 = Math.floor(box.minX / CELL)
    const x1 = Math.floor(box.maxX / CELL)
    const y0 = Math.floor(box.minY / CELL)
    const y1 = Math.floor(box.maxY / CELL)
    for (let cx = x0; cx <= x1; cx++) {
      for (let cy = y0; cy <= y1; cy++) {
        if (visit((cx + 32768) * 65536 + (cy + 32768)) === true) return true
      }
    }
    return false
  }

  add(obstacle: Obstacle): void {
    this.keys(obstacle, (key) => {
      const cell = this.cells.get(key)
      if (cell === undefined) this.cells.set(key, [obstacle])
      else cell.push(obstacle)
    })
  }

  hits(box: Box, owner: string): boolean {
    return this.keys(box, (key) => {
      const cell = this.cells.get(key)
      if (cell === undefined) return false
      return cell.some((other) => other.owner !== owner && overlaps(box, other))
    })
  }
}

function rankOf(node: string, attributes: NodeAttributes, query: LabelQuery): number {
  if (node === query.focus) return 0
  if (query.neighbors.has(node)) return 1
  if (query.focus !== null) return -1
  return attributes.pinned ? 2 : 3
}

export function pickLabels(renderer: BrainRenderer, graph: BrainGraph, query: LabelQuery): Set<string> {
  const { width, height } = renderer.getDimensions()
  const view: Box = { minX: 0, minY: 0, maxX: width, maxY: height }
  const grid = new SpatialGrid()
  const candidates: Candidate[] = []
  graph.forEachNode((node, attributes) => {
    if (!query.visible(attributes) || attributes.glow <= 0) return
    const display = renderer.getNodeDisplayData(node)
    if (display === undefined) return
    const { x, y } = renderer.framedGraphToViewport(display)
    const radius = renderer.scaleSize(display.size)
    const reach = radius + FLOAT_DRIFT
    const core: Obstacle = { owner: node, minX: x - reach, maxX: x + reach, minY: y - reach, maxY: y + reach }
    if (overlaps(core, view)) grid.add(core)
    const rank = rankOf(node, attributes, query)
    if (rank < 0 || attributes.label === '') return
    candidates.push({ node, rank, weight: attributes.size, x, y, radius })
  })
  candidates.sort((a, b) => a.rank - b.rank || b.weight - a.weight)
  const picked = new Set<string>()
  for (const candidate of candidates) {
    const box = labelBox(candidate.x, candidate.y, candidate.radius, graph.getNodeAttribute(candidate.node, 'label'))
    const forced = candidate.rank === 0
    if (!forced && (!overlaps(box, view) || grid.hits(box, candidate.node))) continue
    grid.add({ ...box, owner: candidate.node })
    picked.add(candidate.node)
  }
  return picked
}
