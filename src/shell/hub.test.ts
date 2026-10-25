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
    onLiveAnswer: keep('answer'),
    onSyncFinished: keep('sync'),
    onMeetingMediaChanged: keep('media'),
    onWindowClosed: keep('closed'),
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

    expect([...api.handlers.keys()].sort()).toEqual(['answer', 'closed', 'docs', 'live', 'media', 'snapshot', 'sync', 'tools', 'transcript'])
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

  it('forwards media, sync, answers and window closes as shell events', async () => {
    api.snapshot.mockResolvedValue(idle)
    api.toolsStatus.mockResolvedValue(tools(true, false))
    api.refresh.mockResolvedValue(idle)
    const events: ShellEvent[] = []
    await startHub((event) => events.push(event))
    const change = { id: 'm1', kind: 'compress', ok: true }
    const answer = { askId: 3, event: { type: 'done' } }
    api.handlers.get('media')!(change)
    api.handlers.get('sync')!()
    api.handlers.get('answer')!(answer)
    api.handlers.get('closed')!()
    expect(events.slice(-4)).toEqual([
      { type: 'meeting-media', change },
      { type: 'sync-finished' },
      { type: 'live-answer', answer },
      { type: 'hidden' },
    ])
  })

  it('turns a failed refresh into a snapshot problem', async () => {
    api.snapshot.mockRejectedValue(new Error('sin tauri'))
    api.toolsStatus.mockRejectedValue(new Error('sin tauri'))
    api.refresh.mockRejectedValue({ kind: 'tool-missing', message: 'falta bita', hint: null })
    api.pendingProposals.mockResolvedValue([])
    await startHub(() => undefined)
    expect(shellState().snapshot.problem?.message).toBe('falta bita')
  })

  it('reloads proposals when the window turns visible and announces hidden otherwise', async () => {
    api.snapshot.mockResolvedValue(idle)
    api.toolsStatus.mockResolvedValue(tools(true))
    api.refresh.mockResolvedValue(idle)
    api.pendingProposals.mockResolvedValue([])
    const events: ShellEvent[] = []
    await startHub((event) => events.push(event))
    await vi.waitFor(() => expect(api.pendingProposals).toHaveBeenCalledTimes(1))
    const state = vi.spyOn(document, 'visibilityState', 'get')
    state.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(events.at(-1)).toEqual({ type: 'hidden' })
    const before = api.pendingProposals.mock.calls.length
    state.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
    expect(events.at(-1)).toEqual({ type: 'visible' })
    await vi.waitFor(() => expect(api.pendingProposals.mock.calls.length).toBeGreaterThan(before))
  })

  it('reloads proposals on live state changes and forwards transcripts untouched', async () => {
    api.snapshot.mockResolvedValue(idle)
    api.toolsStatus.mockResolvedValue(tools(true))
    api.refresh.mockResolvedValue(idle)
    api.pendingProposals.mockResolvedValue([])
    const events: ShellEvent[] = []
    await startHub((event) => events.push(event))
    await vi.waitFor(() => expect(api.pendingProposals).toHaveBeenCalledTimes(1))
    const update = { meetingId: 'm1', segments: [] }
    api.handlers.get('transcript')!(update)
    expect(events.at(-1)).toEqual({ type: 'live-transcript', update })
    expect(api.pendingProposals).toHaveBeenCalledTimes(1)
    api.handlers.get('live')!()
    expect(events.some((event) => event.type === 'live-state')).toBe(true)
    await vi.waitFor(() => expect(api.pendingProposals).toHaveBeenCalledTimes(2))
  })

  it('keeps the newest proposals when an older load finishes last', async () => {
    api.snapshot.mockResolvedValue(idle)
    api.toolsStatus.mockResolvedValue(tools(true))
    api.refresh.mockResolvedValue(idle)
    let releaseOld: (value: unknown[]) => void = () => undefined
    api.pendingProposals
      .mockResolvedValueOnce([])
      .mockImplementationOnce(() => new Promise((done) => (releaseOld = done as typeof releaseOld)))
      .mockResolvedValueOnce([{ entryId: 2 }])
    const events: ShellEvent[] = []
    await startHub((event) => events.push(event))
    await vi.waitFor(() => expect(api.pendingProposals).toHaveBeenCalledTimes(1))
    api.handlers.get('docs')!()
    api.handlers.get('docs')!()
    await vi.waitFor(() => expect(api.pendingProposals).toHaveBeenCalledTimes(3))
    releaseOld([{ entryId: 1 }])
    await new Promise((done) => setTimeout(done, 0))
    expect(shellState().proposals).toEqual([{ entryId: 2 }])
  })

  it('falls back to no proposals when loading them fails', async () => {
    api.snapshot.mockResolvedValue(idle)
    api.toolsStatus.mockResolvedValue(tools(true))
    api.refresh.mockResolvedValue(idle)
    api.pendingProposals.mockRejectedValue(new Error('boom'))
    const events: ShellEvent[] = []
    await startHub((event) => events.push(event))
    await vi.waitFor(() => expect(events.at(-1)).toEqual({ type: 'proposals', proposals: [] }))
  })
})
