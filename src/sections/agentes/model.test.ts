import { describe, expect, it } from 'vitest'
import { NO_MODULES, type AgentInfo, type SessionListing, type ToolsStatus } from '../../bita.ts'
import {
  DEFAULT_PANE,
  agentesRoute,
  commandPreview,
  dayLabel,
  duration,
  elapsed,
  folderMeta,
  parseAgentesPath,
  projectArg,
  readiness,
  resumable,
  resumeMeta,
  sessionForEntry,
  sessionTitle,
  shortClock,
  shortPath,
} from './model.ts'

function tools(capabilities: string[], state: 'ready' | 'missing' = 'ready'): ToolsStatus {
  return {
    registryDir: '',
    invalid: [],
    modules: NO_MODULES,
    inkwellMigrated: null,
    tools: [
      {
        name: 'bita',
        known: true,
        state,
        version: '2.0.0',
        capabilities,
        verified: true,
        origin: 'registry',
        command: null,
        manifest: null,
        install: 'npm install -g @kikedealba/bita@latest',
        purpose: null,
      },
    ],
  }
}

function listing(over: Partial<SessionListing> = {}): SessionListing {
  return {
    id: 41,
    entryId: 128,
    harness: 'codex',
    sessionId: null,
    wrapperPid: 99,
    cwd: '/Users/me/dev/viva',
    transcriptPath: null,
    startedAt: '2026-10-25T09:00:00Z',
    endedAt: '2026-10-25T10:12:00Z',
    open: false,
    resumable: true,
    entry: { description: 'Conciliación', projectId: 2, projectName: 'Viva Cash' },
    ...over,
  }
}

function agent(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 1,
    harness: 'claude',
    project: '3',
    cwd: '/Users/me/dev/den',
    title: null,
    prompt: null,
    resumeSession: null,
    pid: 4242,
    startedAt: '2026-10-25T10:00:00Z',
    alive: true,
    exitCode: null,
    bita: null,
    ...over,
  }
}

describe('readiness', () => {
  it('waits while the tools are unknown', () => {
    expect(readiness(null)).toEqual({ kind: 'unknown' })
  })

  it('asks to install bita when it is missing', () => {
    expect(readiness(tools([], 'missing'))).toMatchObject({ kind: 'missing', install: 'npm install -g @kikedealba/bita@latest' })
  })

  it('asks to update bita when it lacks the session capabilities', () => {
    expect(readiness(tools(['sessions.list', 'work.prompt']))).toEqual({
      kind: 'outdated',
      install: 'npm install -g @kikedealba/bita@latest',
      lacking: ['sessions.dirs', 'work.resume.session'],
    })
  })

  it('is ready with all four capabilities', () => {
    expect(readiness(tools(['sessions.list', 'sessions.dirs', 'work.resume.session', 'work.prompt']))).toEqual({ kind: 'ready' })
  })
})

describe('routes', () => {
  it('reads every view from the path', () => {
    expect(parseAgentesPath([])).toEqual({ kind: 'session', id: null })
    expect(parseAgentesPath(['7'])).toEqual({ kind: 'session', id: 7 })
    expect(parseAgentesPath(['nueva'])).toEqual({ kind: 'new' })
    expect(parseAgentesPath(['mosaico'])).toEqual({ kind: 'mosaic' })
    expect(parseAgentesPath(['entry', '131'])).toEqual({ kind: 'entry', entryId: 131 })
    expect(parseAgentesPath(['entry', 'x'])).toEqual({ kind: 'session', id: null })
  })

  it('round trips through the route builder', () => {
    for (const view of [{ kind: 'new' }, { kind: 'mosaic' }, { kind: 'entry', entryId: 5 }, { kind: 'session', id: 3 }] as const) {
      const [section, ...path] = agentesRoute(view).split('/')
      expect(section).toBe('agentes')
      expect(parseAgentesPath(path)).toEqual(view)
    }
    expect(agentesRoute({ kind: 'session', id: null })).toBe('agentes')
  })

  it('finds the session tied to an entry, live first', () => {
    const old = agent({ id: 1, alive: false, bita: listing({ entryId: 9 }) })
    const live = agent({ id: 2, bita: listing({ entryId: 9 }) })
    expect(sessionForEntry([old, live], 9)?.id).toBe(2)
    expect(sessionForEntry([old], 9)?.id).toBe(1)
    expect(sessionForEntry([live], 10)).toBeNull()
  })
})

describe('titles and clocks', () => {
  it('prefers the bita entry, then the title, then the first message', () => {
    expect(sessionTitle(agent())).toBe('Sin nombre todavía')
    expect(sessionTitle(agent({ prompt: 'Arregla el pipeline\ny luego los tests' }))).toBe('Arregla el pipeline')
    expect(sessionTitle(agent({ title: 'Retomada', prompt: 'x' }))).toBe('Retomada')
    expect(sessionTitle(agent({ title: 'Retomada', bita: listing() }))).toBe('Conciliación')
  })

  it('counts hours and minutes since the start', () => {
    const now = new Date('2026-10-25T11:07:30Z')
    expect(elapsed('2026-10-25T10:00:00Z', now)).toBe(4050)
    expect(shortClock(4050)).toBe('1:07')
    expect(shortClock(59)).toBe('0:00')
    expect(elapsed('not a date', now)).toBe(0)
  })
})

describe('the new session form', () => {
  it('previews the exact bita work command', () => {
    expect(commandPreview({ harness: 'claude', project: '3' })).toBe('bita work --harness claude --project=3')
    expect(commandPreview({ harness: 'gemini', project: '0', prompt: "it's -x" })).toBe("bita work --harness gemini --project=0 '--prompt=it'\\''s -x'")
    expect(commandPreview({ resumeSession: 41 })).toBe('bita work --resume --session 41')
  })

  it('takes the project from the folder unless one was picked', () => {
    const folder = { cwd: '/x', lastUsedAt: '', sessions: 1, projectId: 4, projectName: 'den' }
    expect(projectArg('7', folder)).toBe('7')
    expect(projectArg(null, folder)).toBe('4')
    expect(projectArg(null, { ...folder, projectId: null })).toBe('0')
    expect(projectArg(null, null)).toBe('0')
  })

  it('shortens folders to their last two parts', () => {
    expect(shortPath('/Users/me/dev/github.com/KikeDeAlba/den')).toBe('KikeDeAlba/den')
    expect(shortPath('/tmp')).toBe('tmp')
    expect(folderMeta({ cwd: '/x', lastUsedAt: '', sessions: 1, projectId: null, projectName: null })).toBe('sin proyecto · 1 sesión')
    expect(folderMeta({ cwd: '/x', lastUsedAt: '', sessions: 6, projectId: 3, projectName: 'den' })).toBe('den · 6 sesiones')
  })

  it('labels days the way the design does', () => {
    const now = new Date(2026, 9, 25, 12, 0)
    expect(dayLabel(new Date(2026, 9, 25, 8, 0).toISOString(), now)).toBe('hoy')
    expect(dayLabel(new Date(2026, 9, 24, 18, 0).toISOString(), now)).toBe('ayer')
    expect(dayLabel(new Date(2026, 9, 20, 18, 0).toISOString(), now)).toBe('mar')
    expect(dayLabel(new Date(2026, 8, 2, 18, 0).toISOString(), now)).toBe('2/9')
  })

  it('offers only ended sessions that bita can resume', () => {
    const list = [listing({ id: 1 }), listing({ id: 2, open: true }), listing({ id: 3, resumable: false })]
    expect(resumable(list).map((row) => row.id)).toEqual([1])
  })

  it('describes a resumable session with harness, project, start and length', () => {
    const row = listing()
    expect(duration(row)).toBe('1:12')
    expect(resumeMeta(row, new Date('2026-10-25T12:00:00Z'))).toMatch(/^Codex · Viva Cash · hoy \d\d:\d\d · 1:12$/)
    expect(duration(listing({ endedAt: null }))).toBe('')
  })
})

describe('default pane', () => {
  it('opens sessions on the terminal until the activity pane is filled', () => {
    expect(DEFAULT_PANE).toBe('terminal')
  })
})
