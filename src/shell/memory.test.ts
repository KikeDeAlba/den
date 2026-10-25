import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rememberedSection, rememberSection } from './memory.ts'

describe('section memory', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns null when nothing was saved', () => {
    expect(rememberedSection()).toBeNull()
  })

  it('saves and reads back the section under den.section', () => {
    rememberSection('cerebro')
    expect(localStorage.getItem('den.section')).toBe('cerebro')
    expect(rememberedSection()).toBe('cerebro')
  })

  it('keeps only the last section', () => {
    rememberSection('docs')
    rememberSection('tiempo')
    expect(rememberedSection()).toBe('tiempo')
  })

  it('discards a stored value that is not a section', () => {
    localStorage.setItem('den.section', 'borrada')
    expect(rememberedSection()).toBeNull()
    localStorage.setItem('den.section', '')
    expect(rememberedSection()).toBeNull()
    localStorage.setItem('den.section', 'Docs')
    expect(rememberedSection()).toBeNull()
  })

  it('reads null when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    expect(rememberedSection()).toBeNull()
  })

  it('swallows a throwing setItem such as a full quota', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })
    expect(() => rememberSection('docs')).not.toThrow()
    expect(rememberedSection()).toBeNull()
  })

  it('survives localStorage being absent altogether', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(rememberedSection()).toBeNull()
    expect(() => rememberSection('docs')).not.toThrow()
  })

  it('survives the localStorage accessor itself throwing', () => {
    vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError')
    })
    expect(rememberedSection()).toBeNull()
    expect(() => rememberSection('docs')).not.toThrow()
  })
})
