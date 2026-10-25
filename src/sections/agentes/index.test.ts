import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentInfo, SessionListing, ToolsStatus } from '../../bita.ts'

const api = vi.hoisted(() => ({
  spawnAgent: vi.fn(),
  attachAgent: vi.fn(),
  writeAgent: vi.fn(),
  sendAgent: vi.fn(),
  resizeAgent: vi.fn(),
  killAgent: vi.fn(),
  listAgents: vi.fn(),
  bitaSessions: vi.fn(),
  bitaDirs: vi.fn(),
  pickFolder: vi.fn(),
}))

const terminals = vi.hoisted(() => ({
  made: [] as { hooks: { input(data: string): void; resize(cols: number, rows: number): void }; shown: number; hidden: number; written: Uint8Array[]; disposed: boolean }[],
}))

const shell = vi.hoisted(() => ({ tools: null as ToolsStatus | null, go: vi.fn() }))

vi.mock('./api.ts', () => api)

vi.mock('./terminal.ts', () => ({
  createTerminal: (hooks: { input(data: string): void; resize(cols: number, rows: number): void }) => {
    const record = { hooks, shown: 0, hidden: 0, written: [] as Uint8Array[], disposed: false }
    terminals.made.push(record)
    const element = document.createElement('div')
    element.className = 'agentes-xterm'
    return {
      element,
      size: () => ({ cols: 120, rows: 40 }),
      write: (bytes: Uint8Array) => record.written.push(bytes),
      show: () => {
        record.shown += 1
      },
      hide: () => {
        record.hidden += 1
      },
      focus: () => undefined,
      dispose: () => {
        record.disposed = true
        element.remove()
      },
    }
  },
}))

vi.mock('../../bita.ts', () => ({
  projects: vi.fn().mockResolvedValue([
    { id: 3, name: 'den', active: true, clientName: null },
    { id: 4, name: 'Viva Cash', active: true, clientName: null },
  ]),
  describeProblem: (error: unknown) => ({ kind: 'cli-failed', message: String(error), hint: null }),
}))

vi.mock('../../shell/hub.ts', () => ({ shellState: () => ({ tools: shell.tools }) }))
vi.mock('../../shell/routes.ts', () => ({ go: shell.go }))

const section = await import('./index.ts')

function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0))
}

function info(over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 1,
    harness: 'claude',
    project: '3',
    cwd: '/Users/me/dev/den',
    title: null,
    prompt: 'Rediseña Den',
    resumeSession: null,
    pid: 4242,
    startedAt: new Date().toISOString(),
    alive: true,
    exitCode: null,
    bita: null,
    ...over,
  }
}

function listing(over: Partial<SessionListing> = {}): SessionListing {
  return {
    id: 41,
    entryId: 128,
    harness: 'claude',
    sessionId: 'abc',
    wrapperPid: 4242,
    cwd: '/Users/me/dev/den',
    transcriptPath: null,
    startedAt: '2026-10-24T09:00:00Z',
    endedAt: '2026-10-24T10:00:00Z',
    open: false,
    resumable: true,
    entry: { description: 'Barra de menús', projectId: 3, projectName: 'den' },
    ...over,
  }
}

function texts(host: HTMLElement, selector: string): string[] {
  return [...host.querySelectorAll(selector)].map((node) => node.textContent ?? '')
}

function click(host: HTMLElement, selector: string, text: string): void {
  const target = [...host.querySelectorAll<HTMLElement>(selector)].find((node) => node.textContent?.includes(text))
  if (target === undefined) throw new Error(`no ${selector} with ${text}`)
  target.click()
}

describe('agentes section', () => {
  let host: HTMLElement

  beforeEach(() => {
    terminals.made.length = 0
    shell.tools = null
    localStorage.clear()
    host = document.createElement('section')
    host.className = 'section-host'
    host.dataset['section'] = 'agentes'
    document.body.append(host)
    api.listAgents.mockResolvedValue([])
    api.bitaDirs.mockResolvedValue([
      { cwd: '/Users/me/dev/den', lastUsedAt: new Date().toISOString(), sessions: 6, projectId: 3, projectName: 'den' },
      { cwd: '/Users/me/dev/qa', lastUsedAt: '2026-01-02T10:00:00Z', sessions: 1, projectId: null, projectName: null },
    ])
    api.bitaSessions.mockResolvedValue([listing(), listing({ id: 42, open: true })])
    api.resizeAgent.mockResolvedValue(undefined)
    api.writeAgent.mockResolvedValue(undefined)
    api.sendAgent.mockResolvedValue(undefined)
    api.killAgent.mockResolvedValue(undefined)
  })

  afterEach(() => {
    section.unmount()
    host.remove()
  })

  it('shows how to update bita when it lacks the session capabilities', async () => {
    shell.tools = {
      registryDir: '',
      invalid: [],
      inkwellMigrated: null,
      modules: {} as ToolsStatus['modules'],
      tools: [{ name: 'bita', known: true, state: 'ready', version: '1.9.0', capabilities: ['sessions.list'], verified: true, origin: 'registry', command: null, manifest: null, install: 'npm i -g @kikedealba/bita', purpose: null }],
    }
    section.mount(host, [])
    await flush()
    expect(texts(host, '.agentes-gate-title')).toEqual(['Tu bita todavía no sabe lanzar sesiones desde Den'])
    expect(texts(host, '.agentes-gate-hint')).toEqual(['npm i -g @kikedealba/bita'])
  })

  it('opens the new session form with recent folders and resumable sessions', async () => {
    section.mount(host, ['nueva'])
    await flush()
    await flush()
    expect(texts(host, '.agentes-recent-path')).toEqual(['dev/den', 'dev/qa'])
    expect(host.querySelector('.agentes-folder-path')?.textContent).toBe('/Users/me/dev/den')
    expect((host.querySelector('#agentes-project') as HTMLSelectElement).value).toBe('3')
    expect(host.querySelector('.agentes-preview')?.textContent).toBe('bita work --harness claude --project=3')
    expect(texts(host, '.agentes-resume-title')).toEqual(['Barra de menús #41'])
    expect(api.bitaSessions).toHaveBeenLastCalledWith(null)
  })

  it('filters resumable sessions to the chosen folder', async () => {
    section.mount(host, ['nueva'])
    await flush()
    await flush()
    click(host, '.agentes-toggle', 'Esta carpeta')
    await flush()
    expect(api.bitaSessions).toHaveBeenLastCalledWith('/Users/me/dev/den')
  })

  it('updates the preview as the agent and first message change', async () => {
    section.mount(host, ['nueva'])
    await flush()
    await flush()
    click(host, '.agentes-harness-option', 'Codex')
    const prompt = host.querySelector('#agentes-prompt') as HTMLTextAreaElement
    prompt.value = 'arregla el pipeline'
    prompt.dispatchEvent(new Event('input'))
    expect(host.querySelector('.agentes-preview')?.textContent).toBe("bita work --harness codex --project=3 '--prompt=arregla el pipeline'")
  })

  it('starts a session, streams its output and opens its tab', async () => {
    api.spawnAgent.mockImplementation(async (_request: unknown, _cols: number, _rows: number, handler: (bytes: Uint8Array) => void) => {
      handler(new Uint8Array([104, 105]))
      return info({ id: 7 })
    })
    section.mount(host, ['nueva'])
    await flush()
    await flush()
    const prompt = host.querySelector('#agentes-prompt') as HTMLTextAreaElement
    prompt.value = 'Rediseña Den'
    host.querySelector<HTMLFormElement>('.agentes-form')!.requestSubmit()
    await flush()
    expect(api.spawnAgent).toHaveBeenCalledWith(
      { harness: 'claude', project: '3', cwd: '/Users/me/dev/den', prompt: 'Rediseña Den' },
      0,
      0,
      expect.any(Function),
    )
    expect(terminals.made[0]?.written).toEqual([new Uint8Array([104, 105])])
    expect(shell.go).toHaveBeenLastCalledWith('agentes/7')
    section.update(['7'])
    expect(texts(host, '.agentes-tab-title')).toEqual(['Rediseña Den'])
    expect(terminals.made[0]?.shown).toBeGreaterThan(0)
    expect(api.resizeAgent).toHaveBeenCalledWith(7, 120, 40)
  })

  it('reattaches to running sessions and sends composer messages', async () => {
    api.listAgents.mockResolvedValue([info({ id: 3 })])
    api.attachAgent.mockResolvedValue(info({ id: 3 }))
    section.mount(host, [])
    await flush()
    await flush()
    expect(api.attachAgent).toHaveBeenCalledWith(3, expect.any(Function))
    const composer = host.querySelector('#agentes-composer') as HTMLInputElement
    composer.value = 'sigue con los tests'
    composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    expect(api.sendAgent).toHaveBeenCalledWith(3, 'sigue con los tests')
    terminals.made[0]?.hooks.input('q')
    expect(api.writeAgent).toHaveBeenCalledWith(3, 'q')
    click(host, 'button', 'Terminar la sesión')
    expect(api.killAgent).toHaveBeenCalledWith(3)
  })

  it('opens the session tied to an entry once bita links it', async () => {
    api.listAgents.mockResolvedValue([info({ id: 1 }), info({ id: 2, prompt: 'Otra' })])
    api.attachAgent.mockImplementation(async (id: number) => info({ id, prompt: id === 2 ? 'Otra' : 'Rediseña Den' }))
    section.mount(host, ['entry', '128'])
    await flush()
    await flush()
    section.receive({ type: 'agent', info: info({ id: 1, bita: listing({ entryId: 128, open: true }) }) })
    const active = host.querySelector('.agentes-tab--on .agentes-tab-title')
    expect(active?.textContent).toBe('Barra de menús')
  })

  it('offers to resume an ended linked session and to close its tab', async () => {
    api.listAgents.mockResolvedValue([info({ id: 5, alive: false, exitCode: 0, bita: listing({ id: 77 }) })])
    api.attachAgent.mockResolvedValue(info({ id: 5, alive: false, exitCode: 0, bita: listing({ id: 77 }) }))
    api.spawnAgent.mockResolvedValue(info({ id: 6, resumeSession: 77 }))
    section.mount(host, [])
    await flush()
    await flush()
    click(host, '.agentes-composer button', 'Retomar')
    await flush()
    expect(api.spawnAgent.mock.calls.at(-1)?.[0]).toEqual({ resumeSession: 77, cwd: '/Users/me/dev/den', title: 'Barra de menús' })
    section.update(['5'])
    click(host, '.agentes-composer button', 'Cerrar la pestaña')
    expect(terminals.made[0]?.disposed).toBe(true)
  })

  it('lays every session side by side in the mosaic', async () => {
    api.listAgents.mockResolvedValue([info({ id: 1 }), info({ id: 2, prompt: 'Otra' })])
    api.attachAgent.mockImplementation(async (id: number) => info({ id, prompt: id === 2 ? 'Otra' : 'Rediseña Den' }))
    section.mount(host, ['mosaico'])
    await flush()
    await flush()
    expect(host.querySelectorAll('.agentes-tile .agentes-xterm')).toHaveLength(2)
    expect(terminals.made.every((made) => made.shown > 0)).toBe(true)
  })

  it('updates a changed session in place and keeps the composer focus', async () => {
    api.listAgents.mockResolvedValue([info({ id: 3 })])
    api.attachAgent.mockResolvedValue(info({ id: 3 }))
    section.mount(host, [])
    await flush()
    await flush()
    const composer = host.querySelector('#agentes-composer') as HTMLInputElement
    const pane = host.querySelector('.agentes-session')
    const tab = host.querySelector('.agentes-tab[data-session="3"]')
    const term = host.querySelector('.agentes-xterm')
    const shown = terminals.made[0]?.shown
    composer.focus()
    section.receive({ type: 'agent', info: info({ id: 3, bita: listing({ entryId: 128, open: true }) }) })
    expect(document.activeElement).toBe(composer)
    expect(host.querySelector('.agentes-session')).toBe(pane)
    expect(host.querySelector('.agentes-tab[data-session="3"]')).toBe(tab)
    expect(host.querySelector('.agentes-xterm')).toBe(term)
    expect(terminals.made[0]?.shown).toBe(shown)
    expect(texts(host, '.agentes-tab-title')).toEqual(['Barra de menús'])
    expect(texts(host, '.agentes-lane-entry')).toEqual(['entrada #128'])
  })

  it('keeps the terminal focus when the session ends and swaps only its actions', async () => {
    api.listAgents.mockResolvedValue([info({ id: 3 })])
    api.attachAgent.mockResolvedValue(info({ id: 3 }))
    section.mount(host, [])
    await flush()
    await flush()
    const term = host.querySelector('.agentes-xterm') as HTMLElement
    term.tabIndex = 0
    term.focus()
    section.receive({ type: 'agent', info: info({ id: 3, alive: false, exitCode: 0, bita: listing({ id: 77 }) }) })
    expect(document.activeElement).toBe(term)
    expect(term.isConnected).toBe(true)
    expect((host.querySelector('#agentes-composer') as HTMLInputElement).disabled).toBe(true)
    expect(texts(host, '.agentes-composer button')).toEqual(['Retomar', 'Cerrar la pestaña'])
    expect(texts(host, '.agentes-tab-clock')).toEqual(['terminó'])
    expect(texts(host, '.agentes-lane-status')).toEqual(['terminó'])
  })

  it('updates a mosaic tile without rebuilding the grid', async () => {
    api.listAgents.mockResolvedValue([info({ id: 1 }), info({ id: 2, prompt: 'Otra' })])
    api.attachAgent.mockImplementation(async (id: number) => info({ id, prompt: id === 2 ? 'Otra' : 'Rediseña Den' }))
    section.mount(host, ['mosaico'])
    await flush()
    await flush()
    const grid = host.querySelector('.agentes-mosaic')
    section.receive({ type: 'agent', info: info({ id: 2, prompt: 'Otra', alive: false, exitCode: 1 }) })
    expect(host.querySelector('.agentes-mosaic')).toBe(grid)
    expect(texts(host, '.agentes-tile-clock')[1]).toBe('terminó')
  })

  it('remembers a closed tab across reloads and never hides a live session', async () => {
    const ended = info({ id: 5, alive: false, exitCode: 0 })
    const live = info({ id: 6, prompt: 'Sigue viva' })
    api.listAgents.mockResolvedValue([ended, live])
    api.attachAgent.mockImplementation(async (id: number) => (id === 5 ? ended : live))
    section.mount(host, [])
    await flush()
    await flush()
    section.update(['5'])
    click(host, '.agentes-composer button', 'Cerrar la pestaña')
    expect(texts(host, '.agentes-tab-title')).toEqual(['Sigue viva'])
    expect(host.querySelector('.agentes-composer button')?.textContent).toBe('Terminar la sesión')
    section.unmount()
    api.attachAgent.mockClear()
    section.mount(host, [])
    await flush()
    await flush()
    expect(texts(host, '.agentes-tab-title')).toEqual(['Sigue viva'])
    expect(api.attachAgent).toHaveBeenCalledTimes(1)
    expect(api.attachAgent).toHaveBeenCalledWith(6, expect.any(Function))
  })

  it('cannot close the tab of a live session', async () => {
    api.listAgents.mockResolvedValue([info({ id: 3 })])
    api.attachAgent.mockResolvedValue(info({ id: 3 }))
    section.mount(host, [])
    await flush()
    await flush()
    expect(texts(host, '.agentes-composer button')).toEqual(['Terminar la sesión'])
    expect(localStorage.getItem('den.agentes.dismissed')).toBeNull()
  })
})
