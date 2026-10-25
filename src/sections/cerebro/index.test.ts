import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Space } from '../../bita.ts'

const api = vi.hoisted(() => ({
  notesTree: vi.fn(),
  brains: [] as Array<Record<string, ReturnType<typeof vi.fn>>>,
}))

vi.mock('../../bita.ts', async (original) => ({
  ...(await original<typeof import('../../bita.ts')>()),
  notesTree: api.notesTree,
}))

vi.mock('./brain.ts', () => ({
  createBrain: vi.fn(() => {
    const brain = {
      load: vi.fn(() => Promise.resolve()),
      failed: vi.fn(() => false),
      focusSearch: vi.fn(),
      hasSelection: vi.fn(() => false),
      openNote: vi.fn(),
      noteOpen: vi.fn(() => false),
      deselect: vi.fn(),
      dispose: vi.fn(),
    }
    api.brains.push(brain)
    return brain
  }),
}))

const section = await import('./index.ts')
const { loadSpaces } = await import('../../shell/space.ts')

function space(projectSlug: string, pageCount = 1): Space {
  return { projectId: 1, projectName: projectSlug, projectSlug, active: true, entryCount: 0, pageCount, pages: [] }
}

function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0))
}

describe('cerebro section lifecycle', () => {
  let host: HTMLElement

  beforeEach(async () => {
    localStorage.clear()
    api.brains.length = 0
    api.notesTree.mockResolvedValue({ data: { spaces: [space('alpha'), space('beta')] } })
    await loadSpaces(true)
    host = document.createElement('section')
    document.body.append(host)
  })

  afterEach(() => {
    section.unmount()
    host.remove()
  })

  it('is not kept alive so the shell releases the graph when the user leaves', () => {
    expect(section.keepAlive).toBe(false)
  })

  it('loads the remembered space on mount and disposes the brain on unmount', async () => {
    localStorage.setItem('den.space', 'beta')
    await section.mount(host, [])
    expect(api.brains).toHaveLength(1)
    expect(api.brains[0]?.['load']).toHaveBeenCalledWith('beta')
    expect(host.querySelector('.brain-space-name')?.textContent).toBe('beta')
    section.unmount()
    expect(api.brains[0]?.['dispose']).toHaveBeenCalledTimes(1)
  })

  it('prefers the space in the route over the remembered one', async () => {
    localStorage.setItem('den.space', 'beta')
    await section.mount(host, ['alpha'])
    expect(api.brains[0]?.['load']).toHaveBeenCalledWith('alpha')
  })

  it('tolerates unmounting twice and unmounting before mounting', () => {
    expect(() => section.unmount()).not.toThrow()
    void section.mount(host, [])
    section.unmount()
    section.unmount()
    expect(api.brains[0]?.['dispose']).toHaveBeenCalledTimes(1)
  })

  it('disposes the previous brain when mounted again without unmounting', async () => {
    await section.mount(host, [])
    await section.mount(host, [])
    expect(api.brains).toHaveLength(2)
    expect(api.brains[0]?.['dispose']).toHaveBeenCalledTimes(1)
    expect(api.brains[1]?.['dispose']).not.toHaveBeenCalled()
  })

  it('stops answering the keyboard after unmount', async () => {
    await section.mount(host, [])
    section.unmount()
    const event = new KeyboardEvent('keydown', { key: 'f', metaKey: true, ctrlKey: true, cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(api.brains[0]?.['focusSearch']).not.toHaveBeenCalled()
  })

  it('does not load a graph for a mount that was unmounted while spaces were loading', async () => {
    let release: (value: unknown) => void = () => undefined
    api.notesTree.mockReturnValue(new Promise((done) => (release = done)))
    void loadSpaces(true)
    const pending = section.mount(host, [])
    section.unmount()
    release({ data: { spaces: [space('alpha')] } })
    await pending
    await flush()
    expect(api.brains[0]?.['load']).not.toHaveBeenCalled()
  })

  it('switches the graph when the route names another space and shares it with the rest', async () => {
    await section.mount(host, ['alpha'])
    section.update(['beta'])
    expect(api.brains[0]?.['load']).toHaveBeenLastCalledWith('beta')
    expect(localStorage.getItem('den.space')).toBe('beta')
  })
})
