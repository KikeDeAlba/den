import { describe, expect, it, vi } from 'vitest'
import type { SectionModule } from '../sections/section.ts'
import type { SectionId } from './routes.ts'
import { createSections, type Loaders } from './sections.ts'

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

describe('createSections recovery', () => {
  it('marks a section broken when receive throws and remounts it on the next visit', async () => {
    const content = document.createElement('main')
    const fail = vi.fn()
    const broken = fakeModule({
      receive: vi.fn(() => {
        throw new Error('bad event')
      }),
    })
    const healthy = fakeModule()
    const load = vi.fn<() => Promise<SectionModule>>()
    load.mockResolvedValueOnce(broken).mockResolvedValueOnce(healthy)
    const sections = createSections(content, loaders({ tiempo: load }), fail)

    await sections.show({ section: 'tiempo', path: [] })
    await sections.show({ section: 'ahora', path: [] })
    sections.broadcast({ type: 'docs-changed' })
    expect(fail).toHaveBeenCalledTimes(1)
    expect(broken.unmount).toHaveBeenCalledTimes(1)
    expect(hosts(content, 'tiempo')).toHaveLength(0)

    sections.broadcast({ type: 'docs-changed' })
    expect(broken.receive).toHaveBeenCalledTimes(1)

    await sections.show({ section: 'tiempo', path: [] })
    expect(load).toHaveBeenCalledTimes(2)
    expect(healthy.mount).toHaveBeenCalledTimes(1)
    expect(hosts(content, 'tiempo')).toHaveLength(1)
  })

  it('keeps broadcasting to the other sections when one receive throws', async () => {
    const content = document.createElement('main')
    const broken = fakeModule({
      receive: vi.fn(() => {
        throw new Error('bad event')
      }),
    })
    const healthy = fakeModule()
    const sections = createSections(
      content,
      loaders({ ahora: () => Promise.resolve(broken), docs: () => Promise.resolve(healthy) }),
      vi.fn(),
    )
    await sections.show({ section: 'ahora', path: [] })
    await sections.show({ section: 'docs', path: [] })
    const event = { type: 'docs-changed' } as const
    sections.broadcast(event)
    expect(healthy.receive).toHaveBeenCalledWith(event)
  })

  it('marks a section broken when update throws and retries it on the next visit', async () => {
    const content = document.createElement('main')
    const fail = vi.fn()
    const broken = fakeModule({
      update: vi.fn(() => {
        throw new Error('bad route')
      }),
    })
    const healthy = fakeModule()
    const load = vi.fn<() => Promise<SectionModule>>()
    load.mockResolvedValueOnce(broken).mockResolvedValueOnce(healthy)
    const sections = createSections(content, loaders({ docs: load }), fail)

    await sections.show({ section: 'docs', path: [] })
    await sections.show({ section: 'ahora', path: [] })
    await expect(sections.show({ section: 'docs', path: ['espacio'] })).resolves.toBeUndefined()
    expect(fail).toHaveBeenCalledTimes(1)
    expect(broken.unmount).toHaveBeenCalledTimes(1)
    expect(hosts(content, 'docs')).toHaveLength(1)

    await sections.show({ section: 'ahora', path: [] })
    await sections.show({ section: 'docs', path: ['espacio'] })
    expect(load).toHaveBeenCalledTimes(2)
    expect(healthy.mount).toHaveBeenCalledWith(expect.any(HTMLElement), ['espacio'])
    expect(hosts(content, 'docs')).toHaveLength(1)
  })
})
