import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const media = vi.hoisted(() => {
  const state = { width: 1440, listeners: new Set<() => void>(), queries: [] as string[] }
  const limit = (query: string): number => Number(/max-width:\s*(\d+)px/.exec(query)?.[1] ?? Infinity)
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => {
      state.queries.push(query)
      const wanted = limit(query)
      const handlers = new Map<() => void, () => void>()
      return {
        get matches() {
          return state.width <= wanted
        },
        media: query,
        addEventListener: (_type: string, handler: () => void) => {
          const bound = (): void => handler()
          handlers.set(handler, bound)
          state.listeners.add(bound)
        },
        removeEventListener: (_type: string, handler: () => void) => {
          const bound = handlers.get(handler)
          if (bound !== undefined) state.listeners.delete(bound)
        },
      }
    },
  })
  return state
})

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(() => Promise.reject(new Error('offline'))),
  convertFileSrc: (path: string) => path,
  Channel: class {},
}))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
  emit: vi.fn(() => Promise.resolve()),
}))

const section = await import('./index.ts')

function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 20))
}

async function resize(width: number): Promise<void> {
  media.width = width
  for (const listener of [...media.listeners]) listener()
  await flush()
}

function aside(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>('.aside')
}

describe('docs in a narrow window', () => {
  let host: HTMLElement

  beforeEach(() => {
    localStorage.clear()
    media.listeners.clear()
    media.queries.length = 0
    media.width = 1440
    host = document.createElement('section')
    host.dataset['section'] = 'docs'
    document.body.append(host)
  })

  afterEach(() => {
    section.unmount()
    host.remove()
  })

  it('asks for exactly the 1100 px breakpoint', async () => {
    await section.mount(host, [])
    expect(media.queries).toContain('(max-width: 1100px)')
  })

  it('keeps the side panel open at 1440 px', async () => {
    await section.mount(host, [])
    await flush()
    expect(host.querySelector('.docs--narrow')).toBeNull()
    expect(aside(host)?.classList.contains('aside--closed')).toBe(false)
  })

  it.each([1100, 1099, 900])('folds the panel at %i px', async (width) => {
    media.width = width
    await section.mount(host, [])
    await flush()
    expect(host.querySelector('.docs--narrow')).not.toBeNull()
    expect(aside(host)?.classList.contains('aside--closed')).toBe(true)
  })

  it('does not fold the panel at 1101 px', async () => {
    media.width = 1101
    await section.mount(host, [])
    await flush()
    expect(host.querySelector('.docs--narrow')).toBeNull()
  })

  it('folds and restores the panel as the window crosses the breakpoint', async () => {
    await section.mount(host, [])
    await flush()
    await resize(900)
    expect(host.querySelector('.docs--narrow')).not.toBeNull()
    expect(aside(host)?.classList.contains('aside--closed')).toBe(true)
    await resize(1440)
    expect(host.querySelector('.docs--narrow')).toBeNull()
    expect(aside(host)?.classList.contains('aside--closed')).toBe(false)
  })

  it('peeks the panel from the strip without remembering it, and folds it again on resize', async () => {
    media.width = 900
    await section.mount(host, [])
    await flush()
    host.querySelector<HTMLButtonElement>('.aside .strip-icon')?.click()
    await flush()
    expect(aside(host)?.classList.contains('aside--closed')).toBe(false)
    expect(localStorage.getItem('bita.notes.aside')).toBeNull()
    await resize(1440)
    await resize(900)
    expect(aside(host)?.classList.contains('aside--closed')).toBe(true)
  })

  it('does not overwrite the wide preference by folding in a narrow window', async () => {
    localStorage.setItem('bita.notes.aside', 'closed')
    media.width = 900
    await section.mount(host, [])
    await flush()
    await resize(1440)
    expect(localStorage.getItem('bita.notes.aside')).toBe('closed')
  })

  it('stops watching the window after unmount', async () => {
    await section.mount(host, [])
    expect(media.listeners.size).toBeGreaterThan(0)
    const before = media.listeners.size
    section.unmount()
    expect(media.listeners.size).toBeLessThan(before)
  })
})
