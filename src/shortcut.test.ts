import { describe, expect, it } from 'vitest'
import { acceleratorFrom, shortcutLabel } from './shortcut.ts'

function key(code: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { code, ...init })
}

describe('shortcutLabel', () => {
  it('draws Mac glyphs', () => {
    expect(shortcutLabel('CmdOrCtrl+Shift+Space', 'macos')).toBe('⌘⇧Espacio')
    expect(shortcutLabel('Cmd+1', 'macos')).toBe('⌘1')
  })

  it('joins with plus elsewhere', () => {
    expect(shortcutLabel('CmdOrCtrl+Shift+Space', 'linux')).toBe('Ctrl+Shift+Espacio')
    expect(shortcutLabel('Cmd+K', 'windows')).toBe('Win+K')
  })

  it('says there is no shortcut for an empty one', () => {
    expect(shortcutLabel('  ', 'macos')).toBe('sin atajo')
  })
})

describe('acceleratorFrom', () => {
  it('builds an accelerator in a stable modifier order', () => {
    expect(acceleratorFrom(key('KeyK', { metaKey: true, shiftKey: true }))).toBe('Shift+Cmd+K')
    expect(acceleratorFrom(key('Digit1', { ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+1')
  })

  it('refuses a bare key or a Shift-only chord', () => {
    expect(acceleratorFrom(key('KeyK'))).toBeNull()
    expect(acceleratorFrom(key('KeyK', { shiftKey: true }))).toBeNull()
  })

  it('refuses keys it cannot name', () => {
    expect(acceleratorFrom(key('Comma', { metaKey: true }))).toBeNull()
  })
})
