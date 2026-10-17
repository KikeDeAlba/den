import { invoke } from '@tauri-apps/api/core'
import { GAZE_FIXTURE } from './flag.ts'

export const NODE_KINDS = ['rule', 'fact', 'decision', 'doc', 'entry', 'issue', 'meeting', 'memory'] as const
export type NodeKind = (typeof NODE_KINDS)[number]

export const EDGE_KINDS = ['link', 'same-issue', 'same-entry', 'similar'] as const
export type EdgeKind = (typeof EDGE_KINDS)[number]

export interface BrainNode {
  id: string
  project: string
  kind: NodeKind
  title: string
  degree: number
  pinned: boolean
  updatedAt: string | null
}

export interface BrainEdge {
  src: string
  dst: string
  kind: EdgeKind
  weight: number
}

export interface BrainGraph {
  nodes: BrainNode[]
  edges: BrainEdge[]
}

export interface BrainNeighbor {
  id: string
  title: string
  kind: NodeKind
  edgeKind: EdgeKind
}

export interface BrainDetail {
  id: string
  project: string
  kind: NodeKind
  title: string
  body: string
  source: string | null
  sourceRef: string | null
  createdAt: string | null
  updatedAt: string | null
  neighbors: BrainNeighbor[]
}

export interface BrainHit {
  id: string
  title: string
  kind: NodeKind
  project: string
  snippet: string
  score: number
}

interface FixtureNode extends BrainNode {
  body: string
  source: string | null
  sourceRef: string | null
  createdAt: string | null
}

interface Fixture {
  nodes: FixtureNode[]
  edges: BrainEdge[]
}

let fixture: Promise<Fixture> | null = null

function loadFixture(): Promise<Fixture> {
  if (!import.meta.env.DEV) return Promise.reject(new Error('fixture unavailable'))
  fixture ??= import('./fixture.json').then((module) => module.default as Fixture)
  return fixture
}

function isKind<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function optional(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function number(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function nodeKind(value: unknown): NodeKind {
  return isKind(NODE_KINDS, value) ? value : 'memory'
}

function edgeKind(value: unknown): EdgeKind {
  return isKind(EDGE_KINDS, value) ? value : 'link'
}

export function readGraph(raw: unknown): BrainGraph {
  const data = record(raw)
  const nodes: BrainNode[] = []
  const seen = new Set<string>()
  for (const item of Array.isArray(data['nodes']) ? data['nodes'] : []) {
    const node = record(item)
    const id = text(node['id'])
    if (id === '' || seen.has(id)) continue
    seen.add(id)
    nodes.push({
      id,
      project: text(node['project']),
      kind: nodeKind(node['kind']),
      title: text(node['title']) || id,
      degree: number(node['degree']),
      pinned: node['pinned'] === true,
      updatedAt: optional(node['updatedAt']),
    })
  }
  const edges: BrainEdge[] = []
  for (const item of Array.isArray(data['edges']) ? data['edges'] : []) {
    const edge = record(item)
    const src = text(edge['src'])
    const dst = text(edge['dst'])
    if (!seen.has(src) || !seen.has(dst) || src === dst) continue
    edges.push({ src, dst, kind: edgeKind(edge['kind']), weight: number(edge['weight'], 1) })
  }
  return { nodes, edges }
}

export function readDetail(raw: unknown): BrainDetail {
  const data = record(raw)
  const neighbors = (Array.isArray(data['neighbors']) ? data['neighbors'] : []).map((item) => {
    const neighbor = record(item)
    return {
      id: text(neighbor['id']),
      title: text(neighbor['title']) || text(neighbor['id']),
      kind: nodeKind(neighbor['kind']),
      edgeKind: edgeKind(neighbor['edgeKind']),
    }
  })
  return {
    id: text(data['id']),
    project: text(data['project']),
    kind: nodeKind(data['kind']),
    title: text(data['title']) || text(data['id']),
    body: text(data['body']),
    source: optional(data['source']),
    sourceRef: optional(data['sourceRef']),
    createdAt: optional(data['createdAt']),
    updatedAt: optional(data['updatedAt']),
    neighbors: neighbors.filter((neighbor) => neighbor.id !== ''),
  }
}

export function readHits(raw: unknown): BrainHit[] {
  return (Array.isArray(raw) ? raw : [])
    .map((item) => {
      const hit = record(item)
      return {
        id: text(hit['id']),
        title: text(hit['title']) || text(hit['id']),
        kind: nodeKind(hit['kind']),
        project: text(hit['project']),
        snippet: text(hit['snippet']),
        score: number(hit['score']),
      }
    })
    .filter((hit) => hit.id !== '')
}

function fixtureGraph(data: Fixture, project: string | null): BrainGraph {
  const nodes = data.nodes.filter((node) => project === null || node.project === project)
  const ids = new Set(nodes.map((node) => node.id))
  return readGraph({
    nodes,
    edges: data.edges.filter((edge) => ids.has(edge.src) && ids.has(edge.dst)),
  })
}

function fixtureDetail(data: Fixture, id: string): BrainDetail {
  const node = data.nodes.find((candidate) => candidate.id === id)
  if (node === undefined) throw { kind: 'cli-failed', message: `No existe el nodo ${id}.`, hint: null }
  const byId = new Map(data.nodes.map((candidate) => [candidate.id, candidate]))
  const neighbors = data.edges.flatMap((edge) => {
    const other = edge.src === id ? edge.dst : edge.dst === id ? edge.src : null
    const found = other === null ? undefined : byId.get(other)
    return found === undefined ? [] : [{ id: found.id, title: found.title, kind: found.kind, edgeKind: edge.kind }]
  })
  return readDetail({ ...node, neighbors })
}

function fixtureSearch(data: Fixture, query: string, project: string | null): BrainHit[] {
  const needle = query.trim().toLowerCase()
  return data.nodes
    .filter((node) => project === null || node.project === project)
    .map((node) => {
      const inTitle = node.title.toLowerCase().includes(needle)
      const at = node.body.toLowerCase().indexOf(needle)
      const score = (inTitle ? 2 : 0) + (at >= 0 ? 1 : 0)
      const start = Math.max(0, at - 30)
      const snippet = at >= 0 ? node.body.slice(start, at + needle.length + 50).replace(/\s+/g, ' ') : node.title
      return { id: node.id, title: node.title, kind: node.kind, project: node.project, snippet, score }
    })
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 25)
}

export async function brainGraph(project: string | null): Promise<BrainGraph> {
  if (GAZE_FIXTURE) return fixtureGraph(await loadFixture(), project)
  return readGraph(await invoke<unknown>('gaze_graph', { project }))
}

export async function brainShow(id: string): Promise<BrainDetail> {
  if (GAZE_FIXTURE) return fixtureDetail(await loadFixture(), id)
  return readDetail(await invoke<unknown>('gaze_show', { id }))
}

export async function brainSearch(query: string, project: string | null): Promise<BrainHit[]> {
  if (GAZE_FIXTURE) return fixtureSearch(await loadFixture(), query, project)
  return readHits(await invoke<unknown>('gaze_search', { query, project }))
}
