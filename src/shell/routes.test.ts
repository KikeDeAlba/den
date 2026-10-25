import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DEFAULT_SECTION,
  SECTIONS,
  formatRoute,
  go,
  isSection,
  parseRoute,
  sectionLabel,
  shortcutSection,
  type KeyPress,
} from './routes.ts'

function press(key: string, overrides: Partial<KeyPress> = {}): KeyPress {
  return { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...overrides }
}

describe('sections', () => {
  it('lists the eight sections in rail order', () => {
    expect(SECTIONS.map((section) => section.id)).toEqual([
      'ahora',
      'agentes',
      'tiempo',
      'docs',
      'pendientes',
      'reuniones',
      'cerebro',
      'ajustes',
    ])
  })

  it('gives every section its own shortcut key', () => {
    const keys = SECTIONS.map((section) => section.key)
    expect(new Set(keys).size).toBe(SECTIONS.length)
    expect(keys).toEqual(['1', '2', '3', '4', '5', '6', '7', ','])
  })

  it('opens on Ahora by default', () => {
    expect(DEFAULT_SECTION).toBe('ahora')
    expect(isSection(DEFAULT_SECTION)).toBe(true)
  })

  it('recognises only exact section ids', () => {
    expect(isSection('docs')).toBe(true)
    expect(isSection('Docs')).toBe(false)
    expect(isSection('')).toBe(false)
    expect(isSection('constructor')).toBe(false)
    expect(isSection('__proto__')).toBe(false)
  })

  it('labels a section and falls back to the id', () => {
    expect(sectionLabel('pendientes')).toBe('Pendientes y hallazgos')
    expect(sectionLabel('nope' as never)).toBe('nope')
  })

  it('matches the native Go menu in routes, labels and order', () => {
    const source = readFileSync(resolve(process.cwd(), 'src-tauri/src/menu.rs'), 'utf8')
    const block = source.slice(source.indexOf('pub const SECTIONS'), source.indexOf('pub fn route_of'))
    const native = [...block.matchAll(/\("([^"]+)", "([^"]+)", "CmdOrCtrl\+(.)"\)/g)].map((row) => ({
      id: row[1],
      label: row[2],
      key: row[3],
    }))
    expect(native).toEqual(SECTIONS.map(({ id, label, key }) => ({ id, label, key })))
  })
})

describe('parseRoute', () => {
  it('reads a bare section with or without the hash', () => {
    expect(parseRoute('#/tiempo')).toEqual({ section: 'tiempo', path: [] })
    expect(parseRoute('tiempo')).toEqual({ section: 'tiempo', path: [] })
    expect(parseRoute('/tiempo/')).toEqual({ section: 'tiempo', path: [] })
    expect(parseRoute('#tiempo')).toEqual({ section: 'tiempo', path: [] })
  })

  it('keeps the nested path after the section', () => {
    expect(parseRoute('#/docs/den/readme')).toEqual({ section: 'docs', path: ['den', 'readme'] })
  })

  it('decodes percent-encoded parts', () => {
    expect(parseRoute('#/docs/mi%20espacio/p%C3%A1gina')).toEqual({
      section: 'docs',
      path: ['mi espacio', 'página'],
    })
  })

  it('keeps a malformed escape as written instead of throwing', () => {
    expect(parseRoute('#/docs/100%')).toEqual({ section: 'docs', path: ['100%'] })
    expect(parseRoute('#/docs/%E0%A4%A')).toEqual({ section: 'docs', path: ['%E0%A4%A'] })
  })

  it('collapses repeated and trailing slashes and trims spaces', () => {
    expect(parseRoute('  #//docs///a//b/  ')).toEqual({ section: 'docs', path: ['a', 'b'] })
  })

  it('rejects empty, unknown and differently cased sections', () => {
    expect(parseRoute('')).toBeNull()
    expect(parseRoute('#')).toBeNull()
    expect(parseRoute('#/')).toBeNull()
    expect(parseRoute('#/nope')).toBeNull()
    expect(parseRoute('#/Docs')).toBeNull()
    expect(parseRoute('#/%64ocs')).toEqual({ section: 'docs', path: [] })
    expect(parseRoute('#/__proto__')).toBeNull()
  })

  it('does not take a section from a later segment', () => {
    expect(parseRoute('#/nope/docs')).toBeNull()
  })
})

describe('formatRoute', () => {
  it('writes the hash form', () => {
    expect(formatRoute({ section: 'ahora', path: [] })).toBe('#/ahora')
    expect(formatRoute({ section: 'docs', path: ['den', 'readme'] })).toBe('#/docs/den/readme')
  })

  it('encodes parts that would break the path', () => {
    expect(formatRoute({ section: 'docs', path: ['a/b', 'c d', '100%'] })).toBe('#/docs/a%2Fb/c%20d/100%25')
  })

  it('round-trips through parseRoute', () => {
    const route = { section: 'docs' as const, path: ['a/b', 'página #1', '?q=1&x', '100%'] }
    expect(parseRoute(formatRoute(route))).toEqual(route)
  })

  it('round-trips every section', () => {
    for (const { id } of SECTIONS) {
      expect(parseRoute(formatRoute({ section: id, path: [] }))).toEqual({ section: id, path: [] })
    }
  })
})

describe('shortcutSection on a Mac', () => {
  it('maps Cmd+1 to Cmd+7 to the first seven sections', () => {
    const wanted = ['ahora', 'agentes', 'tiempo', 'docs', 'pendientes', 'reuniones', 'cerebro']
    wanted.forEach((id, index) => {
      expect(shortcutSection(press(String(index + 1), { metaKey: true }), true)).toBe(id)
    })
  })

  it('maps Cmd+comma to settings', () => {
    expect(shortcutSection(press(',', { metaKey: true }), true)).toBe('ajustes')
  })

  it('ignores the keys outside the map', () => {
    expect(shortcutSection(press('8', { metaKey: true }), true)).toBeNull()
    expect(shortcutSection(press('0', { metaKey: true }), true)).toBeNull()
    expect(shortcutSection(press('a', { metaKey: true }), true)).toBeNull()
    expect(shortcutSection(press('.', { metaKey: true }), true)).toBeNull()
  })

  it('needs the Command key and nothing else', () => {
    expect(shortcutSection(press('1'), true)).toBeNull()
    expect(shortcutSection(press('1', { ctrlKey: true }), true)).toBeNull()
    expect(shortcutSection(press('1', { metaKey: true, ctrlKey: true }), true)).toBeNull()
    expect(shortcutSection(press('1', { metaKey: true, altKey: true }), true)).toBeNull()
    expect(shortcutSection(press('1', { metaKey: true, shiftKey: true }), true)).toBeNull()
  })
})

describe('shortcutSection off the Mac', () => {
  it('uses Ctrl instead of Command', () => {
    expect(shortcutSection(press('3', { ctrlKey: true }), false)).toBe('tiempo')
    expect(shortcutSection(press(',', { ctrlKey: true }), false)).toBe('ajustes')
    expect(shortcutSection(press('3', { metaKey: true }), false)).toBeNull()
    expect(shortcutSection(press('3', { metaKey: true, ctrlKey: true }), false)).toBeNull()
    expect(shortcutSection(press('3', { ctrlKey: true, altKey: true }), false)).toBeNull()
  })
})

describe('go', () => {
  afterEach(() => {
    location.hash = ''
  })

  it('moves the hash to the normalised route', () => {
    go('tiempo')
    expect(location.hash).toBe('#/tiempo')
    go('#/docs/a b')
    expect(location.hash).toBe('#/docs/a%20b')
  })

  it('does nothing for an unknown route', () => {
    go('docs')
    go('nope')
    go('')
    expect(location.hash).toBe('#/docs')
  })

  it('does not fire hashchange when the route is already current', async () => {
    go('docs')
    await new Promise((resolve) => setTimeout(resolve, 0))
    let fired = 0
    const count = (): void => {
      fired += 1
    }
    window.addEventListener('hashchange', count)
    go('docs')
    go('#/docs/')
    await new Promise((resolve) => setTimeout(resolve, 0))
    window.removeEventListener('hashchange', count)
    expect(fired).toBe(0)
  })
})
