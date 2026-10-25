import { beforeEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({
  snapshot: vi.fn(),
  refresh: vi.fn(),
  toolsStatus: vi.fn(),
  pendingProposals: vi.fn(),
  handlers: new Map<string, (value?: unknown) => void>(),
}))

vi.mock('../bita.ts', async (original) => {
  const actual = await original<typeof import('../bita.ts')>()
  const keep = (name: string) => (handler: (value?: unknown) => void) => {
    api.handlers.set(name, handler)
    return () => undefined
  }
  return {
    ...actual,
    snapshot: api.snapshot,
    refresh: api.refresh,
    toolsStatus: api.toolsStatus,
    pendingProposals: api.pendingProposals,
    onSnapshot: keep('snapshot'),
    onToolsChanged: keep('tools'),
    onDocsChanged: keep('docs'),
    onLiveState: keep('live'),
    onLiveTranscript: keep('transcript'),
  }
})

import { NO_MODULES, type Snapshot, type ToolsStatus } from '../bita.ts'
import type { ShellEvent } from '../sections/section.ts'
import { moduleEnabled, needsSetup, shellState, startHub } from './hub.ts'

const idle: Snapshot = { running: [], todaySeconds: 0, problem: null }

function tools(timers: boolean, proposals = true): ToolsStatus {
  return {
    registryDir: '',
    tools: [],
    invalid: [],
    modules: { ...NO_MODULES, timers, notes: timers, proposals },
    inkwellMigrated: null,
  }
}

beforeEach(() => {
  api.handlers.clear()
  api.snapshot.mockReset()
  api.refresh.mockReset()
  api.toolsStatus.mockReset()
  api.pendingProposals.mockReset()
})

describe('moduleEnabled and needsSetup', () => {
  it('treats unknown tools as enabled', () => {
    expect(moduleEnabled(null, 'timers')).toBe(true)
    expect(moduleEnabled(tools(false), 'timers')).toBe(false)
  })

  it('asks for setup when nothing is installed or bita fails', () => {
    expect(needsSetup({ snapshot: idle, tools: tools(false), proposals: [] })).toBe(true)
    expect(needsSetup({ snapshot: idle, tools: tools(true), proposals: [] })).toBe(false)
    const broken = { ...idle, problem: { kind: 'tool-missing' as const, message: 'falta bita', hint: null } }
    expect(needsSetup({ snapshot: broken, tools: tools(true), proposals: [] })).toBe(true)
  })
})

describe('startHub', () => {
  it('registers every listener once and fans out snapshot, tools and proposals', async () => {
    const counted = { ...idle, todaySeconds: 60 }
    api.snapshot.mockResolvedValue(idle)
    api.toolsStatus.mockResolvedValue(tools(true))
    api.refresh.mockResolvedValue(counted)
    api.pendingProposals.mockResolvedValue([])
    const events: ShellEvent[] = []
    await startHub((event) => events.push(event))
    await vi.waitFor(() => expect(events.some((event) => event.type === 'proposals')).toBe(true))

    expect([...api.handlers.keys()].sort()).toEqual(['docs', 'live', 'snapshot', 'tools', 'transcript'])
    expect(events.map((event) => event.type)).toEqual(['snapshot', 'tools', 'snapshot', 'proposals'])
    expect(shellState().snapshot).toEqual(counted)

    const later = { ...idle, todaySeconds: 120 }
    api.handlers.get('snapshot')!(later)
    expect(events.at(-1)).toEqual({ type: 'snapshot', snapshot: later })
    expect(shellState().snapshot).toEqual(later)
  })

  it('reloads proposals when docs change and skips them without the module', async () => {
    api.snapshot.mockResolvedValue(idle)
    api.toolsStatus.mockResolvedValue(tools(true, false))
    api.refresh.mockResolvedValue(idle)
    const events: ShellEvent[] = []
    await startHub((event) => events.push(event))
    api.handlers.get('docs')!()
    await vi.waitFor(() => expect(events.filter((event) => event.type === 'proposals')).toHaveLength(2))
    expect(api.pendingProposals).not.toHaveBeenCalled()
    expect(events.some((event) => event.type === 'docs-changed')).toBe(true)
  })

  it('turns a failed refresh into a snapshot problem', async () => {
    api.snapshot.mockRejectedValue(new Error('sin tauri'))
    api.toolsStatus.mockRejectedValue(new Error('sin tauri'))
    api.refresh.mockRejectedValue({ kind: 'tool-missing', message: 'falta bita', hint: null })
    api.pendingProposals.mockResolvedValue([])
    await startHub(() => undefined)
    expect(shellState().snapshot.problem?.message).toBe('falta bita')
  })
})
