import Graph from 'graphology'
import Sigma from 'sigma'
import type { EdgeDisplayData, NodeDisplayData } from 'sigma/types'
import { describeProblem, onToolsChanged, openExternal, type Problem } from './bita.ts'
import { element, must } from './dom.ts'
import {
  brainGraph,
  brainSearch,
  brainShow,
  EDGE_KINDS,
  NODE_KINDS,
  type BrainGraph,
  type BrainHit,
  type EdgeKind,
  type NodeKind,
} from './cerebro/api.ts'
import { GAZE_FIXTURE } from './cerebro/flag.ts'
import { bindTrackpad } from './cerebro/gestures.ts'
import type { LayoutFrame, LayoutRequest } from './cerebro/layout.worker.ts'
import { EDGE_LABELS, KIND_LABELS, readPalette, type Palette } from './cerebro/palette.ts'
import { kindDot, sideDetail, sideLoading, sideProblem, type SideHandlers } from './cerebro/side.ts'

interface NodeAttributes {
  x: number
  y: number
  size: number
  color: string
  label: string
  kind: NodeKind
  project: string
  pinned: boolean
}

interface EdgeAttributes {
  kind: EdgeKind
  size: number
  color: string
}

const SEARCH_DELAY = 220
const ALL = ''

const projectSelect = must<HTMLSelectElement>('#brain-project')
const searchInput = must<HTMLInputElement>('#brain-search')
const hitsBox = must<HTMLDivElement>('#brain-hits')
const countLabel = must<HTMLSpanElement>('#brain-count')
const stage = must<HTMLDivElement>('#brain-stage')
const legend = must<HTMLDivElement>('#brain-legend')
const message = must<HTMLDivElement>('#brain-message')
const side = must<HTMLElement>('#brain-side')

const graph = new Graph<NodeAttributes, EdgeAttributes>({ type: 'undirected', multi: true, allowSelfLoops: false })
let palette: Palette = readPalette()

const state = {
  project: null as string | null,
  projects: [] as string[],
  loadToken: 0,
  failed: false,
  hovered: null as string | null,
  selected: null as string | null,
  focus: new Set<string>(),
  hiddenKinds: new Set<NodeKind>(),
  hiddenEdges: new Set<EdgeKind>(),
  pending: null as string | null,
  searchToken: 0,
  showToken: 0,
  hits: [] as BrainHit[],
  activeHit: -1,
}

const renderer = new Sigma<NodeAttributes, EdgeAttributes>(graph, stage, {
  settings: {
    allowInvalidContainer: true,
    renderEdgeLabels: false,
    hideEdgesOnMove: false,
    labelDensity: 0.12,
    labelGridCellSize: 140,
    labelRenderedSizeThreshold: 7,
    zoomToSizeRatioFunction: (ratio) => Math.pow(ratio, 0.25),
  },
  nodeReducer: (node, _data, attributes) => nodeLook(node, attributes),
  edgeReducer: (edge, _data, attributes) => edgeLook(edge, attributes),
})

bindTrackpad(stage, renderer)

const worker = new Worker(new URL('./cerebro/layout.worker.ts', import.meta.url), { type: 'module' })
let layoutRun = 0
let layoutOrder: string[] = []

function nodeVisible(attributes: NodeAttributes): boolean {
  return !state.hiddenKinds.has(attributes.kind)
}

function edgeVisible(edge: string): boolean {
  const attributes = graph.getEdgeAttributes(edge)
  if (state.hiddenEdges.has(attributes.kind)) return false
  const [source, target] = graph.extremities(edge)
  return nodeVisible(graph.getNodeAttributes(source)) && nodeVisible(graph.getNodeAttributes(target))
}

function focusNode(): string | null {
  return state.hovered ?? state.selected
}

function nodeLook(node: string, attributes: NodeAttributes): Partial<NodeDisplayData> {
  if (!nodeVisible(attributes)) return { visibility: 'hidden', labelVisibility: 'hidden' }
  const look: Partial<NodeDisplayData> = { labelColor: palette.label }
  if (attributes.pinned) look.labelVisibility = 'visible'
  const focus = focusNode()
  if (focus === null) return look
  if (node === focus) return { ...look, labelVisibility: 'visible', zIndex: 3 }
  if (state.focus.has(node)) return { ...look, labelVisibility: 'visible', zIndex: 2 }
  return { ...look, color: palette.faded, labelVisibility: 'hidden', zIndex: 0 }
}

function edgeLook(edge: string, attributes: EdgeAttributes): Partial<EdgeDisplayData> {
  if (!edgeVisible(edge)) return { visibility: 'hidden' }
  const focus = focusNode()
  if (focus === null) return {}
  if (graph.hasExtremity(edge, focus)) return { color: palette.strongEdge, size: Math.max(attributes.size, 1.4), zIndex: 2 }
  return { color: palette.fadedEdge, zIndex: 0 }
}

function refreshFocus(): void {
  state.focus.clear()
  const focus = focusNode()
  if (focus !== null && graph.hasNode(focus)) {
    graph.forEachEdge(focus, (edge, _attributes, source, target) => {
      if (edgeVisible(edge)) state.focus.add(source === focus ? target : source)
    })
  }
  renderer.refresh({ skipIndexation: true })
}

function nodeSize(degree: number): number {
  return 2 + Math.min(9, Math.sqrt(Math.max(0, degree)) * 1.4)
}

function seedPositions(data: BrainGraph): Map<string, { x: number; y: number }> {
  const projects = [...new Set(data.nodes.map((node) => node.project))].sort()
  const spread = projects.length > 1 ? 40 * Math.sqrt(data.nodes.length) : 0
  const counts = new Map<string, number>()
  const golden = Math.PI * (3 - Math.sqrt(5))
  const positions = new Map<string, { x: number; y: number }>()
  for (const node of data.nodes) {
    const slot = projects.indexOf(node.project)
    const angle = (slot / Math.max(1, projects.length)) * Math.PI * 2
    const index = counts.get(node.project) ?? 0
    counts.set(node.project, index + 1)
    const radius = 10 * Math.sqrt(index + 1)
    positions.set(node.id, {
      x: Math.cos(angle) * spread + Math.cos(index * golden) * radius,
      y: Math.sin(angle) * spread + Math.sin(index * golden) * radius,
    })
  }
  return positions
}

function fill(data: BrainGraph): void {
  graph.clear()
  const seeds = seedPositions(data)
  const degrees = new Map<string, number>()
  for (const edge of data.edges) {
    degrees.set(edge.src, (degrees.get(edge.src) ?? 0) + 1)
    degrees.set(edge.dst, (degrees.get(edge.dst) ?? 0) + 1)
  }
  for (const node of data.nodes) {
    const seed = seeds.get(node.id) ?? { x: 0, y: 0 }
    graph.addNode(node.id, {
      x: seed.x,
      y: seed.y,
      size: nodeSize(Math.max(node.degree, degrees.get(node.id) ?? 0)),
      color: palette.kinds[node.kind],
      label: node.title,
      kind: node.kind,
      project: node.project,
      pinned: node.pinned,
    })
  }
  for (const edge of data.edges) {
    graph.addEdge(edge.src, edge.dst, {
      kind: edge.kind,
      size: Math.min(3, 0.6 + edge.weight * 0.6),
      color: palette.edges[edge.kind],
    })
  }
}

function startLayout(): void {
  layoutRun += 1
  layoutOrder = graph.nodes()
  const index = new Map(layoutOrder.map((node, at) => [node, at]))
  const positions = new Float32Array(layoutOrder.length * 2)
  layoutOrder.forEach((node, at) => {
    const attributes = graph.getNodeAttributes(node)
    positions[at * 2] = attributes.x
    positions[at * 2 + 1] = attributes.y
  })
  const pairs: number[] = []
  const weights: number[] = []
  graph.forEachEdge((_edge, attributes, source, target) => {
    pairs.push(index.get(source) ?? 0, index.get(target) ?? 0)
    weights.push(attributes.kind === 'similar' ? 0.5 : 1)
  })
  const request: LayoutRequest = {
    run: layoutRun,
    positions,
    edges: Uint32Array.from(pairs),
    weights: Float32Array.from(weights),
  }
  worker.postMessage(request, [request.positions.buffer, request.edges.buffer, request.weights.buffer])
}

worker.addEventListener('message', (event: MessageEvent<LayoutFrame>) => {
  const frame = event.data
  if (frame.run !== layoutRun) return
  const positions = frame.positions
  const index = new Map(layoutOrder.map((node, at) => [node, at]))
  graph.updateEachNodeAttributes(
    (node, attributes) => {
      const at = index.get(node)
      if (at === undefined) return attributes
      attributes.x = positions[at * 2] ?? attributes.x
      attributes.y = positions[at * 2 + 1] ?? attributes.y
      return attributes
    },
    { attributes: ['x', 'y'] },
  )
  if (frame.done && state.pending !== null) {
    const target = state.pending
    state.pending = null
    select(target)
  }
})

function showMessage(content: HTMLElement | null): void {
  message.hidden = content === null
  message.replaceChildren(...(content === null ? [] : [content]))
}

function problemBox(problem: Problem): HTMLElement {
  const box = element('div', 'brain-message-card')
  box.append(element('p', 'brain-message-title', problem.message))
  if (problem.hint !== null) box.append(element('code', 'brain-hint', problem.hint))
  const retry = element('button', 'brain-button', 'Reintentar') as HTMLButtonElement
  retry.type = 'button'
  retry.addEventListener('click', () => void load(state.project))
  box.append(retry)
  return box
}

function plainBox(text: string): HTMLElement {
  const box = element('div', 'brain-message-card')
  box.append(element('p', 'brain-message-title', text))
  return box
}

function renderProjects(): void {
  const current = state.project ?? ALL
  const options = [{ value: ALL, label: 'Todos los proyectos' }, ...state.projects.map((name) => ({ value: name, label: name }))]
  projectSelect.replaceChildren(
    ...options.map((option) => {
      const node = document.createElement('option')
      node.value = option.value
      node.textContent = option.label
      return node
    }),
  )
  projectSelect.value = current
  projectSelect.disabled = state.projects.length === 0
}

function renderCount(): void {
  const nodes = graph.order
  const edges = graph.size
  countLabel.textContent = nodes === 0 ? '' : `${nodes} ${nodes === 1 ? 'nodo' : 'nodos'} · ${edges} ${edges === 1 ? 'conexión' : 'conexiones'}`
}

function renderLegend(): void {
  const counts = new Map<NodeKind, number>()
  graph.forEachNode((_node, attributes) => counts.set(attributes.kind, (counts.get(attributes.kind) ?? 0) + 1))
  const edgeCounts = new Map<EdgeKind, number>()
  graph.forEachEdge((_edge, attributes) => edgeCounts.set(attributes.kind, (edgeCounts.get(attributes.kind) ?? 0) + 1))

  const kinds = element('div', 'brain-legend-group')
  kinds.append(element('span', 'brain-legend-title', 'Tipos'))
  for (const kind of NODE_KINDS) {
    const count = counts.get(kind) ?? 0
    if (count === 0) continue
    const button = element('button', 'brain-legend-item') as HTMLButtonElement
    button.type = 'button'
    button.setAttribute('aria-pressed', String(!state.hiddenKinds.has(kind)))
    button.append(kindDot(palette.kinds[kind]), element('span', 'brain-legend-name', KIND_LABELS[kind]), element('span', 'brain-legend-count', String(count)))
    button.addEventListener('click', () => {
      if (state.hiddenKinds.has(kind)) state.hiddenKinds.delete(kind)
      else state.hiddenKinds.add(kind)
      renderLegend()
      refreshFocus()
    })
    kinds.append(button)
  }

  const edges = element('div', 'brain-legend-group')
  edges.append(element('span', 'brain-legend-title', 'Conexiones'))
  for (const kind of EDGE_KINDS) {
    const label = element('label', 'brain-legend-item brain-legend-toggle')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.checked = !state.hiddenEdges.has(kind)
    box.addEventListener('change', () => {
      if (box.checked) state.hiddenEdges.delete(kind)
      else state.hiddenEdges.add(kind)
      refreshFocus()
    })
    const line = element('span', 'brain-legend-line')
    line.style.setProperty('--dot', palette.edges[kind])
    label.append(box, line, element('span', 'brain-legend-name', EDGE_LABELS[kind]), element('span', 'brain-legend-count', String(edgeCounts.get(kind) ?? 0)))
    edges.append(label)
  }

  legend.replaceChildren(kinds, edges)
  legend.hidden = graph.order === 0
}

async function load(project: string | null): Promise<void> {
  const token = ++state.loadToken
  state.project = project
  showMessage(plainBox('Armando el grafo…'))
  try {
    const data = await brainGraph(project)
    if (token !== state.loadToken) return
    state.failed = false
    if (project === null) state.projects = [...new Set(data.nodes.map((node) => node.project).filter((name) => name !== ''))].sort()
    else if (!state.projects.includes(project)) state.projects = [...state.projects, project].sort()
    state.hovered = null
    if (state.selected !== null && !data.nodes.some((node) => node.id === state.selected)) state.selected = null
    fill(data)
    renderProjects()
    renderCount()
    renderLegend()
    refreshFocus()
    if (data.nodes.length === 0) {
      showMessage(plainBox(project === null ? 'Este cerebro todavía está vacío.' : `No hay nada guardado de ${project}.`))
      return
    }
    showMessage(null)
    startLayout()
  } catch (error) {
    if (token !== state.loadToken) return
    state.failed = true
    graph.clear()
    renderCount()
    renderLegend()
    showMessage(problemBox(describeProblem(error)))
  }
}

const sideHandlers: SideHandlers = {
  onClose: closeSide,
  onNeighbor: (neighbor) => select(neighbor.id),
  onLink: (url) => void openExternal(url),
}

function closeSide(): void {
  state.showToken += 1
  state.selected = null
  side.hidden = true
  refreshFocus()
}

async function openSide(id: string): Promise<void> {
  const token = ++state.showToken
  side.hidden = false
  sideLoading(side, sideHandlers)
  try {
    const detail = await brainShow(id)
    if (token !== state.showToken) return
    sideDetail(side, detail, palette, sideHandlers)
  } catch (error) {
    if (token !== state.showToken) return
    sideProblem(side, describeProblem(error), sideHandlers)
  }
}

function moveCamera(id: string): void {
  const display = renderer.getNodeDisplayData(id)
  if (display === undefined) return
  const camera = renderer.getCamera()
  void camera.animate({ x: display.x, y: display.y, ratio: Math.min(camera.getState().ratio, 0.6) }, { duration: 450 })
}

function select(id: string): void {
  state.selected = id
  refreshFocus()
  if (graph.hasNode(id)) moveCamera(id)
  void openSide(id)
}

function reveal(hit: BrainHit): void {
  if (graph.hasNode(hit.id)) {
    select(hit.id)
    return
  }
  if (state.project !== null && hit.project !== '' && hit.project !== state.project) {
    state.pending = hit.id
    void load(hit.project)
    return
  }
  select(hit.id)
}

function closeHits(): void {
  hitsBox.hidden = true
  searchInput.setAttribute('aria-expanded', 'false')
  state.activeHit = -1
}

function renderHits(note: string | null): void {
  hitsBox.replaceChildren()
  if (note !== null) {
    hitsBox.append(element('div', 'brain-hits-note', note))
  }
  state.hits.forEach((hit, index) => {
    const option = element('button', 'brain-hit') as HTMLButtonElement
    option.type = 'button'
    option.setAttribute('role', 'option')
    option.setAttribute('aria-selected', String(index === state.activeHit))
    const top = element('span', 'brain-hit-top')
    top.append(kindDot(palette.kinds[hit.kind]), element('span', 'brain-hit-title', hit.title))
    if (hit.project !== '' && state.project === null) top.append(element('span', 'brain-hit-project', hit.project))
    option.append(top)
    if (hit.snippet !== '') option.append(element('span', 'brain-hit-snippet', hit.snippet))
    option.addEventListener('mousedown', (event) => event.preventDefault())
    option.addEventListener('click', () => pickHit(index))
    hitsBox.append(option)
  })
  hitsBox.hidden = false
  searchInput.setAttribute('aria-expanded', 'true')
}

function pickHit(index: number): void {
  const hit = state.hits[index]
  if (hit === undefined) return
  closeHits()
  reveal(hit)
}

let searchTimer: ReturnType<typeof setTimeout> | null = null

async function runSearch(query: string): Promise<void> {
  const token = ++state.searchToken
  try {
    const hits = await brainSearch(query, state.project)
    if (token !== state.searchToken) return
    state.hits = hits
    state.activeHit = hits.length > 0 ? 0 : -1
    renderHits(hits.length === 0 ? 'Sin resultados.' : null)
  } catch (error) {
    if (token !== state.searchToken) return
    state.hits = []
    renderHits(describeProblem(error).message)
  }
}

searchInput.addEventListener('input', () => {
  if (searchTimer !== null) clearTimeout(searchTimer)
  const query = searchInput.value.trim()
  if (query.length < 2) {
    state.searchToken += 1
    state.hits = []
    closeHits()
    return
  }
  searchTimer = setTimeout(() => void runSearch(query), SEARCH_DELAY)
})

searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    if (state.hits.length === 0) return
    event.preventDefault()
    const step = event.key === 'ArrowDown' ? 1 : -1
    state.activeHit = (state.activeHit + step + state.hits.length) % state.hits.length
    renderHits(null)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    pickHit(Math.max(0, state.activeHit))
  } else if (event.key === 'Escape') {
    if (!hitsBox.hidden) {
      event.stopPropagation()
      closeHits()
    }
  }
})

searchInput.addEventListener('blur', closeHits)
searchInput.addEventListener('focus', () => {
  if (state.hits.length > 0) renderHits(null)
})

projectSelect.addEventListener('change', () => {
  state.hiddenKinds.clear()
  void load(projectSelect.value === ALL ? null : projectSelect.value)
})

renderer.on('enterNode', ({ node }) => {
  state.hovered = node
  stage.classList.add('brain-stage--pointer')
  refreshFocus()
})

renderer.on('leaveNode', () => {
  state.hovered = null
  stage.classList.remove('brain-stage--pointer')
  refreshFocus()
})

renderer.on('clickNode', ({ node }) => select(node))

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !side.hidden) closeSide()
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    searchInput.focus()
    searchInput.select()
  }
})

function repaint(): void {
  palette = readPalette()
  graph.updateEachNodeAttributes((_node, attributes) => ({ ...attributes, color: palette.kinds[attributes.kind] }), {
    attributes: ['color'],
  })
  graph.updateEachEdgeAttributes((_edge, attributes) => ({ ...attributes, color: palette.edges[attributes.kind] }), {
    attributes: ['color'],
  })
  renderLegend()
  refreshFocus()
}

window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint)

if (!GAZE_FIXTURE) {
  onToolsChanged(() => {
    if (state.failed) void load(state.project)
  })
}

void load(null)
