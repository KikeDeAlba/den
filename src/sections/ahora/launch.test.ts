import { describe, expect, it } from 'vitest'
import { entryRoute, LAUNCH_KINDS, timerKindFor } from './launch.ts'

describe('launcher kinds', () => {
  it('offers only work and meeting', () => {
    expect(LAUNCH_KINDS.map((choice) => choice.label)).toEqual(['Trabajo', 'Reunión'])
  })

  it('starts work without a kind and meetings as remote-meeting for now', () => {
    expect(timerKindFor('work')).toBeNull()
    expect(timerKindFor('meeting')).toBe('remote-meeting')
  })
})

describe('entryRoute', () => {
  it('links a timer to its session, note and transcript', () => {
    expect(entryRoute('session', 7)).toBe('agentes/entry/7')
    expect(entryRoute('note', 7)).toBe('docs/entry/7')
    expect(entryRoute('meeting', 7)).toBe('reuniones/entry/7')
  })
})
