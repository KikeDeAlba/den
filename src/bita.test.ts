import { beforeEach, describe, expect, it, vi } from 'vitest'

const listen = vi.hoisted(() => vi.fn())
const invoke = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/event', () => ({ listen }))
vi.mock('@tauri-apps/api/core', () => ({ invoke, convertFileSrc: (path: string) => path }))

import {
  NAVIGATE_EVENT,
  SNAPSHOT_EVENT,
  describeProblem,
  isMeetingKind,
  onNavigate,
  onSnapshot,
  snapshot,
} from './bita.ts'

type Handler = (event: { payload: unknown }) => void

beforeEach(() => {
  listen.mockReset()
  invoke.mockReset()
})

describe('onNavigate', () => {
  it('listens on den://navigate and hands over the route', () => {
    let registered: Handler | undefined
    listen.mockImplementation((_name: string, handler: Handler) => {
      registered = handler
      return Promise.resolve(() => undefined)
    })
    const received: string[] = []
    onNavigate((route) => received.push(route))
    expect(NAVIGATE_EVENT).toBe('den://navigate')
    expect(listen).toHaveBeenCalledWith('den://navigate', expect.any(Function))
    registered!({ payload: 'ajustes/asistente' })
    expect(received).toEqual(['ajustes/asistente'])
  })

  it('does not reject when the listener cannot be registered', async () => {
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    listen.mockReturnValue(Promise.reject(new Error('no tauri')))
    expect(() => onNavigate(() => undefined)).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
    process.off('unhandledRejection', unhandled)
    expect(unhandled).not.toHaveBeenCalled()
  })
})

describe('onSnapshot', () => {
  it('forwards the payload of bita://snapshot', () => {
    let registered: Handler | undefined
    listen.mockImplementation((_name: string, handler: Handler) => {
      registered = handler
      return Promise.resolve(() => undefined)
    })
    const seen: unknown[] = []
    onSnapshot((value) => seen.push(value))
    expect(listen).toHaveBeenCalledWith(SNAPSHOT_EVENT, expect.any(Function))
    const value = { running: [], todaySeconds: 5, problem: null }
    registered!({ payload: value })
    expect(seen).toEqual([value])
  })
})

describe('subscriptions', () => {
  it('stops delivering and unlistens once the returned function runs', async () => {
    let registered: Handler | undefined
    const unlisten = vi.fn()
    listen.mockImplementation((_name: string, handler: Handler) => {
      registered = handler
      return Promise.resolve(unlisten)
    })
    const seen: unknown[] = []
    const stop = onSnapshot((value) => seen.push(value))
    await Promise.resolve()
    stop()
    expect(unlisten).toHaveBeenCalledTimes(1)
    registered!({ payload: { running: [], todaySeconds: 1, problem: null } })
    expect(seen).toEqual([])
  })

  it('unlistens a registration that resolves after the caller already gave up', async () => {
    const unlisten = vi.fn()
    let finish: (value: () => void) => void = () => undefined
    listen.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const stop = onNavigate(() => undefined)
    stop()
    finish(unlisten)
    await Promise.resolve()
    await Promise.resolve()
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('returns a harmless function when the listener cannot be registered', async () => {
    listen.mockReturnValue(Promise.reject(new Error('no tauri')))
    const stop = onSnapshot(() => undefined)
    await Promise.resolve()
    expect(() => stop()).not.toThrow()
  })
})

describe('snapshot', () => {
  it('invokes the snapshot command', async () => {
    invoke.mockResolvedValue({ running: [], todaySeconds: 0, problem: null })
    await expect(snapshot()).resolves.toEqual({ running: [], todaySeconds: 0, problem: null })
    expect(invoke).toHaveBeenCalledWith('snapshot')
  })

  it('propagates a rejection so the shell can fall back', async () => {
    invoke.mockRejectedValue({ kind: 'tool-missing', message: 'falta bita', hint: null })
    await expect(snapshot()).rejects.toMatchObject({ kind: 'tool-missing' })
  })
})

describe('describeProblem', () => {
  it('keeps a well-formed problem', () => {
    expect(describeProblem({ kind: 'tool-missing', message: 'falta', hint: 'instala' })).toEqual({
      kind: 'tool-missing',
      message: 'falta',
      hint: 'instala',
    })
  })

  it('fills the kind and the hint when absent', () => {
    expect(describeProblem({ message: 'boom' })).toEqual({ kind: 'cli-failed', message: 'boom', hint: null })
  })

  it('wraps strings, errors without a message string and null', () => {
    expect(describeProblem('texto')).toEqual({ kind: 'cli-failed', message: 'texto', hint: null })
    expect(describeProblem(null).message).toBe('null')
    expect(describeProblem(undefined).message).toBe('undefined')
    expect(describeProblem({ message: 3 }).kind).toBe('cli-failed')
    expect(describeProblem(new Error('fallo')).message).toBe('fallo')
  })
})

describe('isMeetingKind', () => {
  it('accepts meeting and the two legacy meeting kinds', () => {
    expect(isMeetingKind('meeting')).toBe(true)
    expect(isMeetingKind('remote-meeting')).toBe(true)
    expect(isMeetingKind('in-person-meeting')).toBe(true)
    expect(isMeetingKind(null)).toBe(false)
    expect(isMeetingKind('work')).toBe(false)
  })

  it('rejects names inherited from Object.prototype', () => {
    expect(isMeetingKind('toString')).toBe(false)
    expect(isMeetingKind('constructor')).toBe(false)
    expect(isMeetingKind('__proto__')).toBe(false)
    expect(isMeetingKind('hasOwnProperty')).toBe(false)
  })
})
