import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => ({
  invoke: vi.fn(),
  setFullscreen: vi.fn(() => Promise.resolve()),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: core.invoke,
  convertFileSrc: (path: string) => path,
  Channel: class {},
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
  emit: vi.fn(() => Promise.resolve()),
}))

vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ setFullscreen: core.setFullscreen }),
}))

import { createLiveView, type LiveMeetingView } from './live.ts'

function answer(id: string, question: string, askedAt: string) {
  return { id, askedAt, question, answer: 'Sí', found: true, sources: [] }
}

const VIEW = {
  active: { meetingId: 'm1', dir: '/tmp/m1', mode: 'meeting', startedAt: '2026-10-25T10:00:00Z' },
  title: 'Seguimiento',
  entryId: null,
  project: null,
  transcript: [],
  answers: [answer('a', '¿Uno?', '2026-10-25T10:01:00Z'), answer('b', '¿Dos?', '2026-10-25T10:02:00Z'), answer('c', '¿Tres?', '2026-10-25T10:03:00Z')],
  asking: false,
  pendingAsks: [],
  shortcut: 'Ctrl+Alt+Space',
  visible: false,
}

function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 20))
}

function selectedQuestion(view: LiveMeetingView): string | null {
  return view.root.querySelector('.rl-item--on')?.textContent ?? null
}

describe('live meeting view in Reuniones', () => {
  let view: LiveMeetingView
  let host: HTMLElement

  beforeEach(async () => {
    localStorage.clear()
    core.invoke.mockImplementation((command: string) => {
      if (command === 'live_state') return Promise.resolve(VIEW)
      if (command === 'live_transcript_full') return Promise.resolve(null)
      if (command === 'recap_config') return Promise.resolve(null)
      return Promise.reject(new Error(`unexpected ${command}`))
    })
    host = document.createElement('section')
    document.body.append(host)
    view = createLiveView({ changed: () => undefined, fullscreen: () => undefined })
    host.append(view.root)
    view.start()
    await flush()
  })

  afterEach(() => {
    view.dispose()
    document.body.replaceChildren()
    vi.clearAllMocks()
  })

  it('walks the questions with the arrow keys outside text fields', () => {
    const first = selectedQuestion(view)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    const bottom = selectedQuestion(view)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }))
    const top = selectedQuestion(view)
    expect(bottom).not.toBe(top)
    expect(view.root.querySelector('.rl-item')?.textContent).toBe(top)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }))
    const afterDown = selectedQuestion(view)
    expect(afterDown).not.toBe(top)
    expect(first).not.toBeNull()
    const input = document.createElement('input')
    host.append(input)
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))
    expect(selectedQuestion(view)).toBe(afterDown)
  })

  it('pauses the clock and leaves full screen when the section hides', async () => {
    const clear = vi.spyOn(window, 'clearInterval')
    const set = vi.spyOn(window, 'setInterval')
    view.root.querySelector<HTMLButtonElement>('[aria-label="Pantalla completa"]')?.click()
    await flush()
    expect(core.setFullscreen).toHaveBeenLastCalledWith(true)
    view.receive({ type: 'hidden' })
    await flush()
    expect(clear).toHaveBeenCalled()
    expect(core.setFullscreen).toHaveBeenLastCalledWith(false)
    expect(set).not.toHaveBeenCalled()
    view.receive({ type: 'visible' })
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('reloads the recap settings when the window regains focus', async () => {
    const before = core.invoke.mock.calls.filter(([command]) => command === 'recap_config').length
    window.dispatchEvent(new Event('focus'))
    await flush()
    expect(core.invoke.mock.calls.filter(([command]) => command === 'recap_config').length).toBe(before + 1)
  })

  it('offers a width divider and drops its listeners on dispose', () => {
    const divider = view.root.querySelector<HTMLElement>('.rl-sash')
    expect(divider?.getAttribute('role')).toBe('separator')
    const remove = vi.spyOn(window, 'removeEventListener')
    view.dispose()
    const removed = remove.mock.calls.map(([type]) => type)
    expect(removed).toEqual(expect.arrayContaining(['resize', 'keydown', 'focus']))
  })
})
