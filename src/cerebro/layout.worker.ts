import Graph from 'graphology'
import forceAtlas2, { type ForceAtlas2Settings } from 'graphology-layout-forceatlas2'

export interface LayoutRequest {
  run: number
  positions: Float32Array
  edges: Uint32Array
  weights: Float32Array
}

export interface LayoutPin {
  pin: number
  index: number
  x: number
  y: number
}

export interface LayoutRelease {
  release: number
  index: number
}

export interface LayoutStop {
  stop: number
}

export type LayoutMessage = LayoutRequest | LayoutPin | LayoutRelease | LayoutStop

export interface LayoutFrame {
  run: number
  positions: Float32Array
  done: boolean
}

const BATCH = 15
const LIVE_ITERATIONS = 2
const LIVE_DELAY = 16
const SETTLE_ITERATIONS = 120
const SETTLE_BATCH = 1
const SETTLE_DELAY = 16

interface Session {
  run: number
  graph: Graph
  settings: ForceAtlas2Settings
  order: number
  remaining: number
  batch: number
  delay: number
  pinned: string | null
  timer: ReturnType<typeof setTimeout> | null
}

let session: Session | null = null

function budget(order: number): number {
  if (order <= 300) return 400
  if (order <= 1500) return 220
  if (order <= 5000) return 120
  return 60
}

function emit(current: Session, done: boolean): void {
  const positions = new Float32Array(current.order * 2)
  current.graph.forEachNode((node, attributes) => {
    const index = Number(node)
    positions[index * 2] = Number(attributes['x'])
    positions[index * 2 + 1] = Number(attributes['y'])
  })
  const frame: LayoutFrame = { run: current.run, positions, done }
  postMessage(frame, { transfer: [positions.buffer] })
}

function schedule(current: Session, delay: number): void {
  if (current.timer !== null) clearTimeout(current.timer)
  current.timer = setTimeout(() => tick(current), delay)
}

function iterate(current: Session, iterations: number): void {
  forceAtlas2.assign(current.graph, { iterations, settings: current.settings, getEdgeWeight: 'weight' })
}

function tick(current: Session): void {
  current.timer = null
  if (session !== current) return
  if (current.pinned !== null) {
    iterate(current, LIVE_ITERATIONS)
    emit(current, false)
    schedule(current, LIVE_DELAY)
    return
  }
  if (current.remaining <= 0) return
  const iterations = Math.min(current.batch, current.remaining)
  iterate(current, iterations)
  current.remaining -= iterations
  emit(current, current.remaining <= 0)
  if (current.remaining > 0) schedule(current, current.delay)
}

function start(request: LayoutRequest): void {
  if (session !== null && session.timer !== null) clearTimeout(session.timer)
  const order = request.positions.length / 2
  const graph = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false })
  for (let index = 0; index < order; index += 1) {
    graph.addNode(String(index), { x: request.positions[index * 2] ?? 0, y: request.positions[index * 2 + 1] ?? 0 })
  }
  for (let index = 0; index < request.edges.length / 2; index += 1) {
    const source = String(request.edges[index * 2])
    const target = String(request.edges[index * 2 + 1])
    if (source === target) continue
    const weight = request.weights[index] ?? 1
    graph.updateEdge(source, target, (attributes) => ({ weight: (Number(attributes['weight']) || 0) + weight }))
  }
  const current: Session = {
    run: request.run,
    graph,
    settings: { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: order > 400, edgeWeightInfluence: 1 },
    order,
    remaining: budget(order),
    batch: BATCH,
    delay: 0,
    pinned: null,
    timer: null,
  }
  session = current
  tick(current)
}

function pin(message: LayoutPin): void {
  const current = session
  if (current === null || current.run !== message.pin) return
  const node = String(message.index)
  if (!current.graph.hasNode(node)) return
  if (current.pinned !== null && current.pinned !== node) current.graph.removeNodeAttribute(current.pinned, 'fixed')
  current.graph.mergeNodeAttributes(node, { x: message.x, y: message.y, fixed: true })
  current.pinned = node
  if (current.timer === null) schedule(current, 0)
}

function release(message: LayoutRelease): void {
  const current = session
  if (current === null || current.run !== message.release) return
  const node = String(message.index)
  if (current.graph.hasNode(node)) current.graph.removeNodeAttribute(node, 'fixed')
  if (current.pinned === node) current.pinned = null
  current.remaining = Math.max(current.remaining, SETTLE_ITERATIONS)
  current.batch = SETTLE_BATCH
  current.delay = SETTLE_DELAY
  schedule(current, SETTLE_DELAY)
}

addEventListener('message', (event: MessageEvent<LayoutMessage>) => {
  const message = event.data
  if ('stop' in message) {
    if (session !== null && session.run === message.stop) {
      if (session.timer !== null) clearTimeout(session.timer)
      session = null
    }
    return
  }
  if ('pin' in message) {
    pin(message)
    return
  }
  if ('release' in message) {
    release(message)
    return
  }
  start(message)
})
