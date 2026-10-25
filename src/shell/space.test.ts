import { beforeEach, describe, expect, it } from 'vitest'
import type { Space } from '../bita.ts'
import { chooseSpace, inkwellProject, inkwellProjectOf, onSpaceChange, rememberedSpace, rememberSpace, sameProject } from './space.ts'

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

const TREE_SPACES: Space[] = [
  { projectId: 220922045, projectKey: 'ALI', projectName: 'Alicia', projectSlug: 'alicia', active: true, entryCount: 1, pageCount: 1, pages: [] },
  { projectId: 222495001, projectKey: 'CDP', projectName: 'DP Caja de pagos', projectSlug: 'dp-caja-de-pagos', active: true, entryCount: 0, pageCount: 38, pages: [] },
  { projectId: 220921563, projectKey: 'DAI', projectName: "Daily's", projectSlug: 'daily-s', active: true, entryCount: 4, pageCount: 1, pages: [] },
]

describe('inkwell project of a space', () => {
  it('passes the key, never the slug, when the slug is not something inkwell knows', () => {
    expect(TREE_SPACES.map(inkwellProject)).toEqual(['ALI', 'CDP', 'DAI'])
    for (const space of TREE_SPACES) expect(inkwellProject(space)).not.toBe(space.projectSlug)
  })

  it('falls back to the id, then the name, then the slug', () => {
    const base = { projectSlug: 'dp-caja-de-pagos', projectName: 'DP Caja de pagos', projectId: 222495001 }
    expect(inkwellProject({ ...base, projectKey: '  ' })).toBe('222495001')
    expect(inkwellProject({ ...base, projectId: null })).toBe('DP Caja de pagos')
    expect(inkwellProject({ ...base, projectId: null, projectName: null })).toBe('dp-caja-de-pagos')
  })

  it('maps the remembered slug to what inkwell accepts', () => {
    expect(inkwellProjectOf(TREE_SPACES, 'dp-caja-de-pagos')).toBe('CDP')
    expect(inkwellProjectOf(TREE_SPACES, 'daily-s')).toBe('DAI')
    expect(inkwellProjectOf(TREE_SPACES, null)).toBeNull()
    expect(inkwellProjectOf(TREE_SPACES, 'gone')).toBe('gone')
  })

  it('recognises the space inkwell names in a sync result', () => {
    const [, caja] = TREE_SPACES
    expect(caja !== undefined && sameProject(caja, 'DP Caja de pagos')).toBe(true)
    expect(caja !== undefined && sameProject(caja, 'cdp')).toBe(true)
    expect(caja !== undefined && sameProject(caja, 'Alicia')).toBe(false)
  })
})
