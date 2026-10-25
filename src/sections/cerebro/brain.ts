import Graph from 'graphology'
import Sigma from 'sigma'
import type { EdgeDisplayData, NodeDisplayData } from 'sigma/types'
import { describeProblem, openExternal, type Problem } from '../../bita.ts'
import { element } from '../../dom.ts'
import {
  brainGraph,
  brainSearch,
  brainShow,
  EDGE_KINDS,
  NODE_KINDS,
  type BrainDetail,
  type BrainGraph,
  type BrainHit,
  type EdgeKind,
  type NodeKind,
} from '../../cerebro/api.ts'
import { bindTrackpad } from '../../cerebro/gestures.ts'
import { LABEL_FONT, LABEL_SIZE, pickLabels, resetLabelMetrics } from '../../cerebro/labels.ts'
import type { LayoutFrame, LayoutPin, LayoutRelease, LayoutRequest, LayoutStop } from '../../cerebro/layout.worker.ts'
import { appear, bindDrag, startFloat } from '../../cerebro/motion.ts'
import { createNoteDialog } from '../../cerebro/note.ts'
import { EDGE_LABELS, fade, KIND_LABELS, mix, readPalette, SKY, type Palette } from '../../cerebro/palette.ts'
import { kindDot, sideDetail, sideEmpty, sideLoading, sideProblem } from '../../cerebro/side.ts'
import { createSky } from '../../cerebro/sky.ts'
import type { EdgeAttributes, NodeAttributes } from '../../cerebro/types.ts'

const SEARCH_DELAY = 220
const CORE_SCALE = 0.42
const CORE_WHITE = 0.7

export interface BrainParts {
  root: HTMLElement
  stage: HTMLElement
  legend: HTMLElement
  count: HTMLElement
  message: HTMLElement
  side: HTMLElement
  search: HTMLInputElement
  hits: HTMLElement
}

export interface BrainView {
  load(project: string | null): Promise<void>
  failed(): boolean
  focusSearch(): void
  hasSelection(): boolean
  openNote(): void
  noteOpen(): boolean
  deselect(): void
  dispose(): void
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

export function createBrain(parts: BrainParts): BrainView {
  const { stage, legend, count, message, side, search, hits } = parts
  const lifetime = new AbortController()
  const signal = lifetime.signal

  const graph = new Graph<NodeAttributes, EdgeAttributes>({ type: 'undirected', multi: true, allowSelfLoops: false })
  let palette: Palette = readPalette()

  const state = {
    project: null as string | null,
    loadToken: 0,
    failed: false,
    hovered: null as string | null,
    selected: null as string | null,
    detail: null as BrainDetail | null,
    focus: new Set<string>(),
    hiddenKinds: new Set<NodeKind>(),
    hiddenEdges: new Set<EdgeKind>(),
    pending: null as string | null,
    searchToken: 0,
    showToken: 0,
    hits: [] as BrainHit[],
    activeHit: -1,
    labels: new Set<string>(),
  }

  const renderer = new Sigma<NodeAttributes, EdgeAttributes>(graph, stage, {
    settings: {
      allowInvalidContainer: true,
      renderEdgeLabels: false,
      hideEdgesOnMove: false,
      labelDensity: 1,
      labelGridCellSize: 60,
      labelRenderedSizeThreshold: 0,
      nodePickingPadding: 5,
      antialiasNodes: true,
      zoomToSizeRatioFunction: (ratio) => Math.pow(ratio, 0.25),
    },
    nodeReducer: (node, _data, attributes) => nodeLook(node, attributes),
    edgeReducer: (edge, _data, attributes) => edgeLook(edge, attributes),
  })

  bindTrackpad(stage, renderer, signal)
  createSky(stage, renderer, graph, signal)

  const worker = new Worker(new URL('../../cerebro/layout.worker.ts', import.meta.url), { type: 'module' })
  let layoutRun = 0
  let layoutOrder: string[] = []
  let layoutIndex = new Map<string, number>()
  let stopAppear: () => void = () => {}
  let leftWhileDragging = false
  let searchTimer: ReturnType<typeof setTimeout> | null = null
  let labelsDirty = false
  const coreColors = new Map<string, string>()

  const note = createNoteDialog(parts.root, {
    palette: () => palette,
    onNavigate: (id) => {
      select(id)
      note.open(id)
    },
    onLink: (url) => void openExternal(url),
    onClose: () => {
      if (!signal.aborted) stage.focus({ preventScroll: true })
    },
  })

  const drag = bindDrag(renderer, graph, stage, {
    onStart: () => float.setLayoutActive(true),
    onMove: (node, x, y) => {
      const index = layoutIndex.get(node)
      if (index === undefined) return
      const pin: LayoutPin = { pin: layoutRun, index, x, y }
      worker.postMessage(pin)
    },
    onRelease: (node) => {
      const index = layoutIndex.get(node)
      if (index !== undefined) {
        const release: LayoutRelease = { release: layoutRun, index }
        worker.postMessage(release)
      }
      if (leftWhileDragging) {
        leftWhileDragging = false
        state.hovered = null
        stage.classList.remove('brain-stage--pointer')
        refreshFocus()
      }
    },
    onCancel: () => stopLayout(),
  })

  const float = startFloat(graph, {
    renderer,
    focus: () => ({ focus: focusNode(), neighbors: state.focus }),
    dragging: () => drag.dragging(),
    signal,
  })

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

  function coreColor(color: string): string {
    let core = coreColors.get(color)
    if (core === undefined) {
      core = mix(color, '#ffffff', CORE_WHITE)
      coreColors.set(color, core)
    }
    return core
  }

  function nodeLook(node: string, attributes: NodeAttributes): Partial<NodeDisplayData> {
    if (!nodeVisible(attributes)) return { visibility: 'hidden', labelVisibility: 'hidden' }
    const look: Partial<NodeDisplayData> = {
      color: coreColor(attributes.color),
      size: attributes.size * CORE_SCALE,
      opacity: Math.max(0, Math.min(1, attributes.glow)),
      labelColor: palette.label,
      labelSize: LABEL_SIZE,
      labelFont: LABEL_FONT,
      backdropColor: SKY.backdrop,
      backdropShadowColor: SKY.backdropShadow,
      backdropArea: 'label',
    }
    if (attributes.glow <= 0) return { ...look, labelVisibility: 'hidden' }
    const focus = focusNode()
    look.labelVisibility = node === focus || state.labels.has(node) ? 'visible' : 'hidden'
    if (focus === null) return look
    if (node === focus) return { ...look, zIndex: 3 }
    if (state.focus.has(node)) return { ...look, zIndex: 2 }
    return { ...look, color: palette.faded, labelVisibility: 'hidden', zIndex: 0 }
  }

  function edgeGlow(edge: string): number {
    const [source, target] = graph.extremities(edge)
    return Math.max(0, Math.min(1, graph.getNodeAttribute(source, 'glow'), graph.getNodeAttribute(target, 'glow')))
  }

  function edgeTone(edge: string, attributes: EdgeAttributes): Partial<EdgeDisplayData> {
    const focus = focusNode()
    const look: Partial<EdgeDisplayData> = { size: attributes.size * 0.6 }
    if (focus === null) return look
    if (graph.hasExtremity(edge, focus)) return { color: palette.strongEdge, size: Math.max(attributes.size, 1.4), zIndex: 2 }
    return { ...look, color: palette.fadedEdge, zIndex: 0 }
  }

  function edgeLook(edge: string, attributes: EdgeAttributes): Partial<EdgeDisplayData> {
    if (!edgeVisible(edge)) return { visibility: 'hidden' }
    const look = edgeTone(edge, attributes)
    const glow = edgeGlow(edge)
    if (glow >= 1) return look
    if (glow <= 0) return { visibility: 'hidden' }
    return { ...look, color: fade(look.color ?? attributes.color, glow) }
  }

  function refreshFocus(): void {
    state.focus.clear()
    const focus = focusNode()
    if (focus !== null && graph.hasNode(focus)) {
      graph.forEachEdge(focus, (edge, _attributes, source, target) => {
        if (edgeVisible(edge)) state.focus.add(source === focus ? target : source)
      })
    }
    labelsDirty = true
    pickNow()
    renderer.refresh({ skipIndexation: true })
  }

  function scheduleLabels(): void {
    if (labelsDirty) return
    labelsDirty = true
    renderer.scheduleRender()
  }

  function pickNow(): boolean {
    if (!labelsDirty) return false
    labelsDirty = false
    const next = pickLabels(renderer, graph, { visible: nodeVisible, focus: focusNode(), neighbors: state.focus })
    if (next.size === state.labels.size && [...next].every((node) => state.labels.has(node))) return false
    state.labels = next
    return true
  }

  function updateLabels(): void {
    if (pickNow()) renderer.scheduleRefresh({ skipIndexation: true })
  }

  renderer.on('afterRender', updateLabels)
  renderer.getCamera().on('updated', scheduleLabels)
  renderer.on('resize', scheduleLabels)
  document.fonts.addEventListener(
    'loadingdone',
    () => {
      resetLabelMetrics()
      scheduleLabels()
    },
    { signal },
  )

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
        baseX: seed.x,
        baseY: seed.y,
        glow: 1,
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
    layoutIndex = new Map(layoutOrder.map((node, at) => [node, at]))
    const index = layoutIndex
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

  function stopLayout(): void {
    const stop: LayoutStop = { stop: layoutRun }
    worker.postMessage(stop)
    layoutRun += 1
    float.setLayoutActive(false)
  }

  worker.addEventListener('message', (event: MessageEvent<LayoutFrame>) => {
    const frame = event.data
    if (frame.run !== layoutRun) return
    const positions = frame.positions
    const held = drag.dragging()
    float.setLayoutActive(!frame.done)
    graph.updateEachNodeAttributes(
      (node, attributes) => {
        const at = layoutIndex.get(node)
        if (at === undefined || node === held) return attributes
        attributes.baseX = positions[at * 2] ?? attributes.baseX
        attributes.baseY = positions[at * 2 + 1] ?? attributes.baseY
        attributes.x = attributes.baseX
        attributes.y = attributes.baseY
        return attributes
      },
      { attributes: ['x', 'y', 'baseX', 'baseY'] },
    )
    scheduleLabels()
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

  function renderCount(): void {
    const nodes = graph.order
    const edges = graph.size
    count.textContent =
      nodes === 0 ? '' : `${nodes} ${nodes === 1 ? 'nota' : 'notas'} · ${edges} ${edges === 1 ? 'conexión' : 'conexiones'}`
  }

  function renderLegend(): void {
    const counts = new Map<NodeKind, number>()
    graph.forEachNode((_node, attributes) => counts.set(attributes.kind, (counts.get(attributes.kind) ?? 0) + 1))
    const edgeCounts = new Map<EdgeKind, number>()
    graph.forEachEdge((_edge, attributes) => edgeCounts.set(attributes.kind, (edgeCounts.get(attributes.kind) ?? 0) + 1))

    const kinds = element('div', 'brain-legend-group')
    kinds.append(element('span', 'brain-legend-title', 'Tipos'))
    for (const kind of NODE_KINDS) {
      const total = counts.get(kind) ?? 0
      if (total === 0) continue
      const button = element('button', 'brain-legend-item') as HTMLButtonElement
      button.type = 'button'
      button.setAttribute('aria-pressed', String(!state.hiddenKinds.has(kind)))
      button.append(
        kindDot(palette.kinds[kind]),
        element('span', 'brain-legend-name', KIND_LABELS[kind]),
        element('span', 'brain-legend-count', String(total)),
      )
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
      label.append(
        box,
        line,
        element('span', 'brain-legend-name', EDGE_LABELS[kind]),
        element('span', 'brain-legend-count', String(edgeCounts.get(kind) ?? 0)),
      )
      edges.append(label)
    }

    legend.replaceChildren(kinds, edges)
    legend.hidden = graph.order === 0
  }

  async function load(project: string | null): Promise<void> {
    const token = ++state.loadToken
    if (project !== state.project) {
      state.hiddenKinds.clear()
      closeHits()
      state.hits = []
    }
    state.project = project
    showMessage(plainBox('Armando el grafo…'))
    try {
      const data = await brainGraph(project)
      if (token !== state.loadToken || signal.aborted) return
      state.failed = false
      state.hovered = null
      if (state.selected !== null && !data.nodes.some((node) => node.id === state.selected)) deselect()
      drag.cancel()
      stopAppear()
      leftWhileDragging = false
      fill(data)
      float.reset()
      stopAppear = appear(graph, () => {
        renderer.refresh({ skipIndexation: true, schedule: true })
        scheduleLabels()
      })
      renderCount()
      renderLegend()
      refreshFocus()
      if (data.nodes.length === 0) {
        stopLayout()
        showMessage(plainBox(project === null ? 'Este cerebro todavía está vacío.' : `No hay nada guardado de ${project}.`))
        return
      }
      showMessage(null)
      startLayout()
    } catch (error) {
      if (token !== state.loadToken || signal.aborted) return
      state.failed = true
      drag.cancel()
      stopLayout()
      graph.clear()
      renderCount()
      renderLegend()
      showMessage(problemBox(describeProblem(error)))
    }
  }

  async function openSide(id: string): Promise<void> {
    const token = ++state.showToken
    state.detail = null
    sideLoading(side)
    try {
      const detail = await brainShow(id)
      if (token !== state.showToken || signal.aborted) return
      state.detail = detail
      sideDetail(side, detail, palette, {
        onOpen: openNote,
        onNeighbor: (neighbor) => select(neighbor.id),
      })
    } catch (error) {
      if (token !== state.showToken || signal.aborted) return
      sideProblem(side, describeProblem(error))
    }
  }

  function deselect(): void {
    state.showToken += 1
    state.selected = null
    state.detail = null
    sideEmpty(side)
    refreshFocus()
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

  function openNote(): void {
    const id = state.selected
    if (id === null) return
    note.open(id, state.detail)
  }

  function closeHits(): void {
    hits.hidden = true
    search.setAttribute('aria-expanded', 'false')
    state.activeHit = -1
  }

  function renderHits(note: string | null): void {
    hits.replaceChildren()
    if (note !== null) hits.append(element('div', 'brain-hits-note', note))
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
      hits.append(option)
    })
    hits.hidden = false
    search.setAttribute('aria-expanded', 'true')
  }

  function pickHit(index: number): void {
    const hit = state.hits[index]
    if (hit === undefined) return
    closeHits()
    select(hit.id)
  }

  async function runSearch(query: string): Promise<void> {
    const token = ++state.searchToken
    try {
      const found = await brainSearch(query, state.project)
      if (token !== state.searchToken || signal.aborted) return
      state.hits = found
      state.activeHit = found.length > 0 ? 0 : -1
      renderHits(found.length === 0 ? 'Sin resultados.' : null)
    } catch (error) {
      if (token !== state.searchToken || signal.aborted) return
      state.hits = []
      renderHits(describeProblem(error).message)
    }
  }

  search.addEventListener('input', () => {
    if (searchTimer !== null) clearTimeout(searchTimer)
    const query = search.value.trim()
    if (query.length < 2) {
      state.searchToken += 1
      state.hits = []
      closeHits()
      return
    }
    searchTimer = setTimeout(() => void runSearch(query), SEARCH_DELAY)
  })

  search.addEventListener('keydown', (event) => {
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
      event.stopPropagation()
      if (!hits.hidden) closeHits()
      else search.blur()
    }
  })

  search.addEventListener('blur', closeHits)
  search.addEventListener('focus', () => {
    if (state.hits.length > 0) renderHits(null)
  })

  renderer.on('enterNode', ({ node }) => {
    leftWhileDragging = false
    if (drag.dragging() !== null) return
    state.hovered = node
    stage.classList.add('brain-stage--pointer')
    refreshFocus()
  })

  renderer.on('leaveNode', () => {
    if (drag.dragging() !== null) {
      leftWhileDragging = true
      return
    }
    state.hovered = null
    stage.classList.remove('brain-stage--pointer')
    refreshFocus()
  })

  renderer.on('clickNode', ({ node }) => {
    if (drag.consumeDrag()) return
    select(node)
  })

  renderer.on('doubleClickNode', ({ node, preventSigmaDefault }) => {
    if (!drag.releasedRecently()) return
    preventSigmaDefault()
    drag.consumeDrag()
    select(node)
  })

  function repaint(): void {
    palette = readPalette()
    coreColors.clear()
    graph.updateEachNodeAttributes((_node, attributes) => ({ ...attributes, color: palette.kinds[attributes.kind] }), {
      attributes: ['color'],
    })
    graph.updateEachEdgeAttributes((_edge, attributes) => ({ ...attributes, color: palette.edges[attributes.kind] }), {
      attributes: ['color'],
    })
    renderLegend()
    refreshFocus()
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', repaint, { signal })

  sideEmpty(side)
  closeHits()

  return {
    load,
    failed: () => state.failed,
    focusSearch() {
      search.focus()
      search.select()
    },
    hasSelection: () => state.selected !== null,
    openNote,
    noteOpen: () => note.isOpen(),
    deselect,
    dispose() {
      if (signal.aborted) return
      state.loadToken += 1
      state.searchToken += 1
      state.showToken += 1
      if (searchTimer !== null) clearTimeout(searchTimer)
      stopAppear()
      lifetime.abort()
      note.dispose()
      worker.terminate()
      renderer.kill()
      graph.clear()
    },
  }
}
