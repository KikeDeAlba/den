import { describe, expect, it, vi } from 'vitest'
import type { SectionModule } from '../sections/section.ts'
import type { SectionId } from './routes.ts'
import { createSections, type Loaders } from './sections.ts'

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function fakeModule(overrides: Partial<SectionModule> = {}): SectionModule {
  return {
    mount: vi.fn(),
    update: vi.fn(),
    unmount: vi.fn(),
    receive: vi.fn(),
    ...overrides,
  }
}

function loaders(map: Partial<Record<SectionId, () => Promise<SectionModule>>>): Loaders {
  const missing = (): Promise<SectionModule> => Promise.resolve(fakeModule())
  return {
    ahora: map.ahora ?? missing,
    agentes: map.agentes ?? missing,
    tiempo: map.tiempo ?? missing,
    docs: map.docs ?? missing,
    pendientes: map.pendientes ?? missing,
    reuniones: map.reuniones ?? missing,
    cerebro: map.cerebro ?? missing,
    ajustes: map.ajustes ?? missing,
  }
}

function hosts(content: HTMLElement, section: SectionId): HTMLElement[] {
  return [...content.querySelectorAll<HTMLElement>(`.section-host[data-section="${section}"]`)]
}

describe('createSections', () => {
  it('drops a section whose mount failed and retries it with a fresh host', async () => {
    const content = document.createElement('main')
    const fail = vi.fn()
    const broken = fakeModule({ mount: vi.fn(() => Promise.reject(new Error('boom'))) })
    const healthy = fakeModule()
    const load = vi.fn<() => Promise<SectionModule>>()
    load.mockResolvedValueOnce(broken).mockResolvedValueOnce(healthy)
    const sections = createSections(content, loaders({ docs: load }), fail)

    await sections.show({ section: 'docs', path: [] })
    expect(fail).toHaveBeenCalledTimes(1)
    expect(broken.unmount).toHaveBeenCalledTimes(1)
    expect(broken.update).not.toHaveBeenCalled()
    const first = hosts(content, 'docs')
    expect(first).toHaveLength(1)

    await sections.show({ section: 'ahora', path: [] })
    expect(hosts(content, 'docs')[0]?.hidden).toBe(true)
    await sections.show({ section: 'docs', path: ['espacio'] })
    expect(load).toHaveBeenCalledTimes(2)
    expect(healthy.mount).toHaveBeenCalledWith(expect.any(HTMLElement), ['espacio'])
    const second = hosts(content, 'docs')
    expect(second).toHaveLength(1)
    expect(second[0]).not.toBe(first[0])
  })

  it('removes a failed host right away when the user already left the section', async () => {
    const content = document.createElement('main')
    const gate = deferred<SectionModule>()
    const sections = createSections(content, loaders({ cerebro: () => gate.promise }), vi.fn())
    const pending = sections.show({ section: 'cerebro', path: [] })
    await sections.show({ section: 'ahora', path: [] })
    gate.resolve(fakeModule({ mount: () => Promise.reject(new Error('sin grafo')) }))
    await pending
    expect(hosts(content, 'cerebro')).toHaveLength(0)
  })

  it('does not update a module that is still mounting and applies the last route once mounted', async () => {
    const content = document.createElement('main')
    const mounting = deferred<void>()
    const module = fakeModule({ mount: vi.fn(() => mounting.promise) })
    const sections = createSections(content, loaders({ docs: () => Promise.resolve(module) }), vi.fn())

    const first = sections.show({ section: 'docs', path: ['a'] })
    await Promise.resolve()
    await Promise.resolve()
    await sections.show({ section: 'docs', path: ['b'] })
    await sections.show({ section: 'docs', path: ['c'] })
    expect(module.update).not.toHaveBeenCalled()

    mounting.resolve()
    await first
    expect(module.mount).toHaveBeenCalledTimes(1)
    expect(module.update).toHaveBeenCalledTimes(1)
    expect(module.update).toHaveBeenCalledWith(['c'])
  })

  it('mounts with the newest route when it changes while the module is imported', async () => {
    const content = document.createElement('main')
    const gate = deferred<SectionModule>()
    const module = fakeModule()
    const sections = createSections(content, loaders({ docs: () => gate.promise }), vi.fn())
    const first = sections.show({ section: 'docs', path: ['a'] })
    await sections.show({ section: 'docs', path: ['b'] })
    gate.resolve(module)
    await first
    expect(module.mount).toHaveBeenCalledWith(expect.any(HTMLElement), ['b'])
    expect(module.update).not.toHaveBeenCalled()
  })

  it('broadcasts only to sections that finished mounting', async () => {
    const content = document.createElement('main')
    const ready = fakeModule()
    const gate = deferred<SectionModule>()
    const late = fakeModule()
    const sections = createSections(
      content,
      loaders({ ahora: () => Promise.resolve(ready), docs: () => gate.promise }),
      vi.fn(),
    )
    await sections.show({ section: 'ahora', path: [] })
    const loading = sections.show({ section: 'docs', path: [] })
    const event = { type: 'docs-changed' } as const
    sections.broadcast(event)
    expect(ready.receive).toHaveBeenCalledWith(event)
    expect(late.receive).not.toHaveBeenCalled()
    gate.resolve(late)
    await loading
    sections.broadcast(event)
    expect(late.receive).toHaveBeenCalledWith(event)
  })

  it('unmounts sections that do not keep alive when leaving them', async () => {
    const content = document.createElement('main')
    const brain = fakeModule({ keepAlive: false })
    const sections = createSections(content, loaders({ cerebro: () => Promise.resolve(brain) }), vi.fn())
    await sections.show({ section: 'cerebro', path: [] })
    await sections.show({ section: 'ahora', path: [] })
    expect(brain.unmount).toHaveBeenCalledTimes(1)
    expect(hosts(content, 'cerebro')).toHaveLength(0)
    expect(sections.current()).toBe('ahora')
  })

  it('tells a kept section that it was hidden when leaving it', async () => {
    const content = document.createElement('main')
    const agents = fakeModule()
    const brain = fakeModule({ keepAlive: false })
    const sections = createSections(content, loaders({ agentes: () => Promise.resolve(agents), cerebro: () => Promise.resolve(brain) }), vi.fn())
    await sections.show({ section: 'agentes', path: [] })
    await sections.show({ section: 'cerebro', path: [] })
    expect(agents.receive).toHaveBeenCalledWith({ type: 'hidden' })
    expect(hosts(content, 'agentes')[0]?.hidden).toBe(true)
    await sections.show({ section: 'ahora', path: [] })
    expect(brain.receive).not.toHaveBeenCalled()
  })
})
