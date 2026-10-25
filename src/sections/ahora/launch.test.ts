import { describe, expect, it } from 'vitest'
import { LAUNCH_KINDS, timerKindFor } from './launch.ts'

describe('launcher kinds', () => {
  it('offers only work and meeting', () => {
    expect(LAUNCH_KINDS.map((choice) => choice.label)).toEqual(['Trabajo', 'Reunión'])
  })

  it('starts work without a kind and meetings as remote-meeting for now', () => {
    expect(timerKindFor('work')).toBeNull()
    expect(timerKindFor('meeting')).toBe('remote-meeting')
  })
})
