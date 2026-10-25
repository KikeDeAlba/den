import { afterEach, describe, expect, it } from 'vitest'
import type { LiveTimer, Snapshot } from '../bita.ts'
import { buildTopbar, leaderOf } from './topbar.ts'

function timer(overrides: Partial<LiveTimer> = {}): LiveTimer {
  return {
    id: 1,
    title: 'Algo',
    docRelPath: null,
    sectionsWritten: null,
    sectionsTotal: null,
    touchedSinceNote: null,
    projectName: null,
    projectId: null,
    startedAt: '2026-09-20T05:00:00Z',
    startLocal: '2026-09-20T05:00:00',
    elapsedSeconds: 0,
    draft: false,
    kind: null,
    ...overrides,
  }
}

function snapshot(running: LiveTimer[]): Snapshot {
  return { running, todaySeconds: 0, problem: null }
}

function parts(bar: HTMLElement): { name: string; extra: string; clock: string; button: HTMLButtonElement } {
  const button = bar.querySelector<HTMLButtonElement>('button.leader')!
  return {
    name: button.querySelector('.leader-name')!.textContent ?? '',
    extra: button.querySelector('.leader-extra')!.textContent ?? '',
    clock: button.querySelector('.leader-clock')!.textContent ?? '',
    button,
  }
}

describe('leaderOf', () => {
  it('is null with nothing running', () => {
    expect(leaderOf([])).toBeNull()
  })

  it('picks the oldest timer', () => {
    const late = timer({ id: 1, startedAt: '2026-09-20T06:00:00Z' })
    const early = timer({ id: 2, startedAt: '2026-09-20T05:00:00Z' })
    expect(leaderOf([late, early])).toBe(early)
  })

  it('breaks a tie on the lower id whatever the input order', () => {
    const first = timer({ id: 3 })
    const second = timer({ id: 7 })
    expect(leaderOf([second, first])).toBe(first)
    expect(leaderOf([first, second])).toBe(first)
  })
})

describe('topbar', () => {
  afterEach(() => {
    location.hash = ''
  })

  it('is a drag region and shows the section title', () => {
    const bar = buildTopbar()
    bar.title('Tiempo')
    expect(bar.element.hasAttribute('data-tauri-drag-region')).toBe(true)
    expect(bar.element.querySelector('.topbar-title')!.textContent).toBe('Tiempo')
  })

  it('shows the idle state with no timers', () => {
    const bar = buildTopbar()
    bar.show(snapshot([]))
    const view = parts(bar.element)
    expect(view.button.dataset['idle']).toBe('true')
    expect(view.name).toBe('Sin cronómetro')
    expect(view.clock).toBe('')
    expect(view.extra).toBe('')
  })

  it('shows the leader clock to the second and counts the others', () => {
    const bar = buildTopbar()
    bar.show(
      snapshot([
        timer({ id: 2, title: 'Segundo', startedAt: '2026-09-20T06:00:00Z', elapsedSeconds: 60 }),
        timer({ id: 1, title: 'Primero', elapsedSeconds: 3725 }),
      ]),
    )
    const view = parts(bar.element)
    expect(view.button.dataset['idle']).toBe('false')
    expect(view.name).toBe('Primero')
    expect(view.extra).toBe('+1')
    expect(view.clock).toBe('01:02:05')
    expect(view.button.getAttribute('aria-label')).toBe('Primero, 01:02:05; ir a Ahora')
  })

  it('names an untitled draft, then falls back to the project, then to a generic name', () => {
    const bar = buildTopbar()
    bar.show(snapshot([timer({ title: null, draft: true })]))
    expect(parts(bar.element).name).toBe('Sin nombre')
    bar.show(snapshot([timer({ title: null, projectName: 'Pharma STI' })]))
    expect(parts(bar.element).name).toBe('Pharma STI')
    bar.show(snapshot([timer({ title: null })]))
    expect(parts(bar.element).name).toBe('Cronómetro')
  })

  it('clears the extra count and the clock when the timers stop', () => {
    const bar = buildTopbar()
    bar.show(snapshot([timer({ id: 1 }), timer({ id: 2 })]))
    expect(parts(bar.element).extra).toBe('+1')
    bar.show(snapshot([]))
    const view = parts(bar.element)
    expect(view.extra).toBe('')
    expect(view.clock).toBe('')
  })

  it('clamps a negative elapsed time to zero', () => {
    const bar = buildTopbar()
    bar.show(snapshot([timer({ elapsedSeconds: -30 })]))
    expect(parts(bar.element).clock).toBe('00:00:00')
  })

  it('goes to Ahora when the leader is clicked', () => {
    const bar = buildTopbar()
    location.hash = '#/docs'
    parts(bar.element).button.click()
    expect(location.hash).toBe('#/ahora')
  })
})
