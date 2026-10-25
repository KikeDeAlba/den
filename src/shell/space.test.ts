import { beforeEach, describe, expect, it } from 'vitest'
import type { Space } from '../bita.ts'
import { chooseSpace, onSpaceChange, rememberedSpace, rememberSpace } from './space.ts'

function space(projectSlug: string, pageCount: number): Space {
  return { projectId: null, projectName: null, projectSlug, active: true, entryCount: 0, pageCount, pages: [] }
}

describe('shared space', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('falls back to the legacy notes key', () => {
    localStorage.setItem('bita.notes.space', 'legacy')
    expect(rememberedSpace()).toBe('legacy')
  })

  it('prefers den.space over the legacy key', () => {
    localStorage.setItem('bita.notes.space', 'legacy')
    rememberSpace('den')
    expect(localStorage.getItem('den.space')).toBe('den')
    expect(rememberedSpace()).toBe('den')
  })

  it('tells every section once when the space changes', () => {
    const seen: string[] = []
    const stop = onSpaceChange((slug) => seen.push(slug))
    rememberSpace('alpha')
    rememberSpace('alpha')
    rememberSpace('beta')
    stop()
    rememberSpace('gamma')
    expect(seen).toEqual(['alpha', 'beta'])
  })

  it('chooses the wanted space, then one with pages, then the first', () => {
    const list = [space('empty', 0), space('full', 3)]
    expect(chooseSpace(list, 'empty')?.projectSlug).toBe('empty')
    expect(chooseSpace(list, 'missing')?.projectSlug).toBe('full')
    expect(chooseSpace([space('only', 0)], null)?.projectSlug).toBe('only')
    expect(chooseSpace([], null)).toBeNull()
  })
})
