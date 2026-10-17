import Graph from 'graphology'
import forceAtlas2 from 'graphology-layout-forceatlas2'

export interface LayoutRequest {
  run: number
  positions: Float32Array
  edges: Uint32Array
  weights: Float32Array
}

export interface LayoutFrame {
  run: number
  positions: Float32Array
  done: boolean
}

const BATCH = 15

function budget(order: number): number {
  if (order <= 300) return 400
  if (order <= 1500) return 220
  if (order <= 5000) return 120
  return 60
}

let current = 0

function run(request: LayoutRequest): void {
  current = request.run
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

  const settings = { ...forceAtlas2.inferSettings(graph), barnesHutOptimize: order > 400, edgeWeightInfluence: 1 }
  const total = budget(order)
  let done = 0

  const step = (): void => {
    if (current !== request.run) return
    const iterations = Math.min(BATCH, total - done)
    forceAtlas2.assign(graph, { iterations, settings, getEdgeWeight: 'weight' })
    done += iterations
    const positions = new Float32Array(order * 2)
    graph.forEachNode((node, attributes) => {
      const index = Number(node)
      positions[index * 2] = Number(attributes['x'])
      positions[index * 2 + 1] = Number(attributes['y'])
    })
    const frame: LayoutFrame = { run: request.run, positions, done: done >= total }
    postMessage(frame, { transfer: [positions.buffer] })
    if (done < total) setTimeout(step, 0)
  }
  step()
}

addEventListener('message', (event: MessageEvent<LayoutRequest | { stop: number }>) => {
  const message = event.data
  if ('stop' in message) {
    if (current === message.stop) current = -1
    return
  }
  run(message)
})
