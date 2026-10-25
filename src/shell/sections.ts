import type { SectionModule, ShellEvent } from '../sections/section.ts'
import { element } from '../dom.ts'
import type { Route, SectionId } from './routes.ts'

export type Loaders = Record<SectionId, () => Promise<SectionModule>>

type State = 'loading' | 'ready' | 'failed'

interface Entry {
  host: HTMLElement
  module: SectionModule | null
  state: State
  path: readonly string[]
}

export interface Sections {
  show(route: Route): Promise<void>
  broadcast(event: ShellEvent): void
  current(): SectionId | null
}

function samePath(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((part, index) => part === right[index])
}

export function createSections(
  content: HTMLElement,
  loaders: Loaders,
  fail: (host: HTMLElement, error: unknown) => void,
): Sections {
  const entries = new Map<SectionId, Entry>()
  let current: SectionId | null = null

  function release(section: SectionId, entry: Entry): void {
    if (entries.get(section) === entry) entries.delete(section)
    entry.host.remove()
  }

  function leave(section: SectionId): void {
    const entry = entries.get(section)
    if (entry === undefined) return
    entry.host.hidden = true
    if (entry.state !== 'ready' || entry.module === null) return
    if (entry.module.keepAlive !== false) {
      try {
        entry.module.receive?.({ type: 'hidden' })
      } catch (error) {
        broke(section, entry, error)
      }
      return
    }
    entry.module.unmount()
    release(section, entry)
  }

  function broke(section: SectionId, entry: Entry, error: unknown): void {
    if (entry.module !== null) {
      try {
        entry.module.unmount()
      } catch {
        entry.module = null
      }
    }
    entry.module = null
    entry.state = 'failed'
    fail(entry.host, error)
    if (current !== section) release(section, entry)
  }

  async function load(route: Route): Promise<void> {
    const host = element('section', 'section-host')
    host.dataset['section'] = route.section
    content.append(host)
    const entry: Entry = { host, module: null, state: 'loading', path: route.path }
    entries.set(route.section, entry)
    let mountedPath: readonly string[] = route.path
    try {
      entry.module = await loaders[route.section]()
      mountedPath = entry.path
      await entry.module.mount(host, mountedPath)
    } catch (error) {
      broke(route.section, entry, error)
      return
    }
    entry.state = 'ready'
    if (!samePath(mountedPath, entry.path)) {
      try {
        entry.module.update(entry.path)
      } catch (error) {
        broke(route.section, entry, error)
        return
      }
    }
    if (current !== route.section) leave(route.section)
  }

  return {
    async show(route) {
      const previous = current
      current = route.section
      if (previous !== null && previous !== route.section) leave(previous)
      const entry = entries.get(route.section)
      if (entry !== undefined && entry.state === 'failed') release(route.section, entry)
      const live = entries.get(route.section)
      if (live === undefined) {
        await load(route)
        return
      }
      live.host.hidden = false
      live.path = route.path
      if (live.state !== 'ready' || live.module === null) return
      try {
        live.module.update(route.path)
      } catch (error) {
        broke(route.section, live, error)
      }
    },
    broadcast(event) {
      for (const [section, entry] of [...entries]) {
        if (entry.state !== 'ready') continue
        try {
          entry.module?.receive?.(event)
        } catch (error) {
          broke(section, entry, error)
        }
      }
    },
    current: () => current,
  }
}
