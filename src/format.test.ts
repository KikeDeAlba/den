import { describe, expect, it } from 'vitest'
import { clock, human, startedAt } from './format.ts'

describe('clock', () => {
  it('pads hours, minutes and seconds', () => {
    expect(clock(0)).toBe('00:00:00')
    expect(clock(59)).toBe('00:00:59')
    expect(clock(3661)).toBe('01:01:01')
    expect(clock(360_000)).toBe('100:00:00')
  })

  it('floors fractions and clamps negatives', () => {
    expect(clock(59.9)).toBe('00:00:59')
    expect(clock(-5)).toBe('00:00:00')
  })
})

describe('human', () => {
  it('drops the hours when there are none', () => {
    expect(human(0)).toBe('0m')
    expect(human(59)).toBe('0m')
    expect(human(3540)).toBe('59m')
    expect(human(3600)).toBe('1h 0m')
    expect(human(5400)).toBe('1h 30m')
    expect(human(-1)).toBe('0m')
  })
})

describe('startedAt', () => {
  it('cuts the local time to HH:MM', () => {
    expect(startedAt('2026-09-20T05:48:20')).toBe('05:48')
  })
})
