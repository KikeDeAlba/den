import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DISMISSED_KEY, DISMISSED_LIMIT, canDismiss, isDismissed, pruneDismissed, readDismissed, rememberDismissed, sessionKey } from './dismissed.ts'

const ended = { id: 4, startedAt: '2026-10-25T09:00:00Z', alive: false }

describe('dismissed agent tabs', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => vi.restoreAllMocks())

  it('keys a session by its id and start so a reused id is not hidden', () => {
    rememberDismissed(ended)
    const dismissed = readDismissed()
    expect(isDismissed(ended, dismissed)).toBe(true)
    expect(isDismissed({ ...ended, startedAt: '2026-10-26T09:00:00Z' }, dismissed)).toBe(false)
    expect(sessionKey(ended)).toBe('4@2026-10-25T09:00:00Z')
  })

  it('never hides or closes a live session', () => {
    rememberDismissed(ended)
    expect(isDismissed({ ...ended, alive: true }, readDismissed())).toBe(false)
    expect(canDismiss({ alive: true })).toBe(false)
    expect(canDismiss({ alive: false })).toBe(true)
  })

  it('forgets sessions Den no longer knows about', () => {
    rememberDismissed(ended)
    rememberDismissed({ id: 9, startedAt: 'x' })
    pruneDismissed([ended])
    expect([...readDismissed()]).toEqual([sessionKey(ended)])
    pruneDismissed([])
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull()
  })

  it('keeps only the latest keys', () => {
    for (let id = 1; id <= DISMISSED_LIMIT + 5; id += 1) rememberDismissed({ id, startedAt: 's' })
    const keys = [...readDismissed()]
    expect(keys).toHaveLength(DISMISSED_LIMIT)
    expect(keys.at(-1)).toBe(`${DISMISSED_LIMIT + 5}@s`)
  })

  it('survives broken or blocked storage', () => {
    localStorage.setItem(DISMISSED_KEY, '{nope')
    expect(readDismissed().size).toBe(0)
    localStorage.setItem(DISMISSED_KEY, '[1, "a"]')
    expect([...readDismissed()]).toEqual(['a'])
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readDismissed().size).toBe(0)
    expect(() => rememberDismissed(ended)).not.toThrow()
  })
})
