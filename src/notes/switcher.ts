import type { Space } from '../bita.ts'
import { element, icon } from '../dom.ts'
import { projectColor } from '../shell/colors.ts'
import { foldForSearch } from './markdown.ts'
import './spaces.css'
import { modKey } from '../platform.ts'

export interface SwitcherOptions {
  anchor: HTMLElement
  spaces: Space[]
  active: string | null
  onPick: (slug: string) => void
}

let open: { root: HTMLElement; close: () => void } | null = null
let quietOpen = false

export function withPages(spaces: Space[]): Space[] {
  return spaces.filter((space) => space.pageCount > 0)
}

export function isSwitcherOpen(): boolean {
  return open !== null
}

export function closeSwitcher(): void {
  open?.close()
}

export function toggleSwitcher(options: SwitcherOptions): void {
  if (open !== null) {
    closeSwitcher()
    return
  }
  openSwitcher(options)
}

export function openSwitcher(options: SwitcherOptions): void {
  closeSwitcher()
  const root = element('div', 'switcher')
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-label', 'Cambiar de espacio')

  const field = element('label', 'switcher-search')
  const glass = element('span', 'search-glass')
  glass.append(icon('search', 13))
  const input = document.createElement('input')
  input.type = 'search'
  input.placeholder = 'Cambiar de espacio…'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.setAttribute('aria-label', 'Filtrar espacios')
  field.append(glass, input, element('span', 'kbd', modKey('K')))

  const list = element('div', 'switcher-list')
  list.setAttribute('role', 'listbox')
  root.append(field, list)

  let cursor = 0

  const pick = (slug: string): void => {
    close()
    options.onPick(slug)
  }

  const paint = (): void => {
    const needle = foldForSearch(input.value.trim())
    const matches = (space: Space): boolean =>
      needle.length === 0 || foldForSearch(space.projectName ?? space.projectSlug).includes(needle)
    const main = withPages(options.spaces)
    const quiet = options.spaces.filter((space) => space.pageCount === 0)
    const shown = main.filter(matches)
    const shownQuiet = quiet.filter(matches)
    const showQuiet = quietOpen || needle.length > 0
    const flat = [...shown, ...(showQuiet ? shownQuiet : [])]
    cursor = Math.min(cursor, Math.max(0, flat.length - 1))
    list.replaceChildren()

    const row = (space: Space, index: number, shortcut: string | null): HTMLElement => {
      const button = document.createElement('button')
      button.type = 'button'
      const on = space.projectSlug === options.active
      button.className = ['switcher-option', on ? 'switcher-option--on' : '', index === cursor ? 'switcher-option--cursor' : '']
        .filter(Boolean)
        .join(' ')
      button.setAttribute('role', 'option')
      button.setAttribute('aria-selected', String(on))
      const dot = element('span', 'dot')
      dot.style.background = space.pageCount > 0 ? projectColor(space.projectId) : 'transparent'
      if (space.pageCount === 0) dot.style.border = '1px solid var(--elev-strong)'
      button.append(dot, element('span', 'switcher-name', space.projectName ?? 'Sin proyecto'))
      button.append(element('span', 'kbd', String(space.pageCount > 0 ? space.pageCount : space.entryCount)))
      button.append(element('span', 'kbd switcher-key', shortcut ?? ''))
      button.addEventListener('click', () => pick(space.projectSlug))
      button.addEventListener('mousemove', () => {
        if (cursor === index) return
        cursor = index
        for (const [at, other] of [...list.querySelectorAll('.switcher-option')].entries()) {
          other.classList.toggle('switcher-option--cursor', at === cursor)
        }
      })
      return button
    }

    shown.forEach((space, index) => {
      const position = main.indexOf(space)
      list.append(row(space, index, position < 9 ? modKey(String(position + 1)) : null))
    })
    if (shown.length === 0 && shownQuiet.length === 0) {
      list.append(element('p', 'switcher-empty', `Ningún espacio se llama «${input.value.trim()}».`))
    }

    if (quiet.length > 0) {
      list.append(element('div', 'switcher-rule'))
      const toggle = document.createElement('button')
      toggle.type = 'button'
      toggle.className = 'switcher-option switcher-option--group'
      toggle.setAttribute('aria-expanded', String(showQuiet))
      toggle.append(
        icon(showQuiet ? 'chevronDown' : 'chevronRight', 11),
        element('span', 'switcher-name', 'Proyectos sin páginas'),
        element('span', 'kbd', String(quiet.length)),
      )
      toggle.addEventListener('click', () => {
        quietOpen = !quietOpen
        paint()
        input.focus()
      })
      list.append(toggle)
      if (showQuiet) shownQuiet.forEach((space, index) => list.append(row(space, shown.length + index, null)))
    }

    const current = list.querySelector('.switcher-option--cursor')
    current?.scrollIntoView({ block: 'nearest' })
    root.dataset['flat'] = flat.map((space) => space.projectSlug).join('\n')
  }

  input.addEventListener('input', () => {
    cursor = 0
    paint()
  })
  input.addEventListener('keydown', (event) => {
    const flat = (root.dataset['flat'] ?? '').split('\n').filter(Boolean)
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      cursor = Math.min(flat.length - 1, cursor + 1)
      paint()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      cursor = Math.max(0, cursor - 1)
      paint()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const slug = flat[cursor]
      if (slug !== undefined) pick(slug)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
      options.anchor.focus()
    }
  })

  const outside = (event: MouseEvent): void => {
    if (!(event.target instanceof Node)) return
    if (root.contains(event.target) || options.anchor.contains(event.target)) return
    close()
  }

  function close(): void {
    document.removeEventListener('mousedown', outside, true)
    root.remove()
    options.anchor.setAttribute('aria-expanded', 'false')
    if (open?.root === root) open = null
  }

  const rect = options.anchor.getBoundingClientRect()
  root.style.left = `${Math.round(rect.left)}px`
  root.style.top = `${Math.round(rect.bottom + 6)}px`
  const host = document.querySelector<HTMLElement>('.section-host:not([hidden]) .notes-root') ?? document.body
  host.append(root)
  options.anchor.setAttribute('aria-expanded', 'true')
  document.addEventListener('mousedown', outside, true)
  open = { root, close }
  const activeIndex = withPages(options.spaces).findIndex((space) => space.projectSlug === options.active)
  cursor = Math.max(0, activeIndex)
  paint()
  input.focus()
}
