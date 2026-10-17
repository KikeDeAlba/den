import type { EdgeKind, NodeKind } from './api.ts'

export interface NodeAttributes {
  x: number
  y: number
  baseX: number
  baseY: number
  glow: number
  size: number
  color: string
  label: string
  kind: NodeKind
  project: string
  pinned: boolean
}

export interface EdgeAttributes {
  kind: EdgeKind
  size: number
  color: string
}
