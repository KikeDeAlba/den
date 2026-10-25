import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.hoisted(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
  })
})

const sigma = vi.hoisted(() => ({
  instances: [] as Array<{ kill: ReturnType<typeof vi.fn> }>,
  workers: [] as Array<{ terminate: ReturnType<typeof vi.fn> }>,
}))

vi.mock('sigma', () => ({
  default: class {
    kill = vi.fn()
    constructor() {
      sigma.instances.push(this)
    }
    on = vi.fn()
    off = vi.fn()
    getCamera = () => ({ on: vi.fn(), off: vi.fn(), getState: () => ({ x: 0, y: 0, ratio: 1, angle: 0 }), setState: vi.fn(), animate: vi.fn(), disable: vi.fn(), enable: vi.fn() })
    getMouseCaptor = () => ({ on: vi.fn(), off: vi.fn() })
    getTouchCaptor = () => ({ on: vi.fn(), off: vi.fn() })
    getContainer = () => document.createElement('div')
    getCanvases = () => ({})
    getDimensions = () => ({ width: 100, height: 100 })
    getGraph = () => ({})
    refresh = vi.fn()
    scheduleRender = vi.fn()
    scheduleRefresh = vi.fn()
    setSetting = vi.fn()
    getSetting = vi.fn()
    resize = vi.fn()
    viewportToGraph = (point: unknown) => point
    graphToViewport = (point: unknown) => point
    getNodeDisplayData = vi.fn()
  },
}))

vi.mock('../../cerebro/sky.ts', () => ({ createSky: vi.fn() }))
vi.mock('../../cerebro/gestures.ts', () => ({ bindTrackpad: vi.fn() }))

vi.mock('../../cerebro/api.ts', async (original) => ({
  ...(await original<typeof import('../../cerebro/api.ts')>()),
  brainGraph: vi.fn(() => Promise.resolve({ nodes: [], edges: [] })),
}))

const { createBrain } = await import('./brain.ts')

function parts(): Parameters<typeof createBrain>[0] {
  const make = (tag: string): HTMLElement => document.createElement(tag)
  const root = make('div')
  const stage = make('div')
  const legend = make('div')
  const count = make('span')
  const message = make('div')
  const side = make('aside')
  const search = document.createElement('input')
  const hits = make('div')
  root.append(stage, legend, count, message, side, search, hits)
  document.body.append(root)
  return { root, stage, legend, count, message, side, search, hits }
}

describe('brain resources', () => {
  beforeEach(() => {
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: { addEventListener: vi.fn(), removeEventListener: vi.fn(), load: vi.fn(() => Promise.resolve([])), ready: Promise.resolve() },
    })
    sigma.instances.length = 0
    sigma.workers.length = 0
    vi.stubGlobal(
      'Worker',
      class {
        terminate = vi.fn()
        postMessage = vi.fn()
        addEventListener = vi.fn()
        removeEventListener = vi.fn()
        onmessage = null
        constructor() {
          sigma.workers.push(this)
        }
      },
    )
  })

  afterEach(() => {
    document.body.replaceChildren()
  })

  it('kills the renderer and terminates the layout worker on dispose', () => {
    const view = createBrain(parts())
    expect(sigma.instances).toHaveLength(1)
    expect(sigma.workers).toHaveLength(1)
    view.dispose()
    expect(sigma.instances[0]?.kill).toHaveBeenCalledTimes(1)
    expect(sigma.workers[0]?.terminate).toHaveBeenCalledTimes(1)
  })

  it('releases once even when disposed twice', () => {
    const view = createBrain(parts())
    view.dispose()
    view.dispose()
    expect(sigma.instances[0]?.kill).toHaveBeenCalledTimes(1)
    expect(sigma.workers[0]?.terminate).toHaveBeenCalledTimes(1)
  })

  it('gives every mount its own renderer and worker', () => {
    const first = createBrain(parts())
    first.dispose()
    const second = createBrain(parts())
    expect(sigma.instances).toHaveLength(2)
    expect(sigma.workers).toHaveLength(2)
    expect(sigma.instances[1]?.kill).not.toHaveBeenCalled()
    second.dispose()
  })
})
