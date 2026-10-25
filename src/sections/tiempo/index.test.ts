import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const bita = vi.hoisted(() => ({
  toolsStatus: vi.fn(),
  timeSummary: vi.fn(),
  pending: vi.fn(),
  snapshot: vi.fn(),
  worked: vi.fn(),
}))

const reports = vi.hoisted(() => ({
  mountReports: vi.fn(),
  choose: vi.fn(),
  span: vi.fn(),
  current: vi.fn(),
  conceal: vi.fn(),
  dispose: vi.fn(),
}))

vi.mock('../../bita.ts', () => ({
  ...bita,
  describeProblem: (error: unknown) => ({ message: String(error), hint: null }),
}))

vi.mock('../../reportes/mount.ts', () => ({
  mountReports: reports.mountReports,
}))

const section = await import('./index.ts')

function flush(): Promise<void> {
  return new Promise((done) => setTimeout(done, 0))
}

function texts(host: HTMLElement, selector: string): string[] {
  return [...host.querySelectorAll(selector)].map((node) => node.textContent ?? '')
}

describe('tiempo section', () => {
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement('section')
    host.className = 'section-host'
    host.dataset['section'] = 'tiempo'
    document.body.append(host)
    reports.mountReports.mockReturnValue({ choose: reports.choose, span: reports.span, current: reports.current, conceal: reports.conceal, dispose: reports.dispose })
    reports.current.mockReturnValue({ preset: 'custom', from: '2026-10-01', to: '2026-10-07' })
    bita.toolsStatus.mockResolvedValue({ modules: { jira: true } })
    bita.pending.mockResolvedValue({ groups: [{ entryIds: [1] }] })
    bita.snapshot.mockResolvedValue({ running: [], todaySeconds: 0, problem: null })
    bita.timeSummary.mockResolvedValue({
      totalSeconds: 5400,
      totalHuman: '',
      jiraSeconds: 5400,
      nonJiraSeconds: 0,
      nonJira: null,
      estimateSeconds: 5400,
      overlaps: [],
      excluded: [],
      groups: [
        {
          summary: 'Firma BBVA',
          projectId: 7,
          projectName: 'CoDi',
          totalSeconds: 5400,
          totalHuman: '',
          estimateSeconds: 5400,
          estimateHuman: '',
          entryIds: [1, 2],
          days: ['2026-10-24'],
          partIndex: 1,
          partCount: 1,
          jiraProjectKey: 'COD',
          jira: true,
          issueKey: 'COD-12',
        },
      ],
    })
    bita.worked.mockResolvedValue({ totalSeconds: 600, groups: [], overlaps: [] })
  })

  afterEach(() => {
    section.unmount()
    host.remove()
    location.hash = ''
  })

  it('renders today as a task table with worked, estimate and the Jira key', async () => {
    section.mount(host, [])
    await flush()
    expect(bita.timeSummary).toHaveBeenCalledWith('today')
    expect(texts(host, '.tiempo-row:not(.tiempo-row--head) .tiempo-title')).toEqual(['Firma BBVA'])
    expect(texts(host, '.tiempo-key')).toEqual(['COD-12'])
    expect(texts(host, '.tiempo-state')).toEqual(['1 sin registrar'])
    expect(texts(host, '.tiempo-figure')).toEqual(['1:30', '1:30'])
    expect(host.textContent).toContain('1 worklog sin registrar en 1 tarea')
    expect(host.querySelector('.tiempo-range[aria-pressed="true"]')?.textContent).toBe('Hoy')
  })

  it('asks for the week when the route says so', async () => {
    section.mount(host, ['semana'])
    await flush()
    expect(bita.timeSummary).toHaveBeenCalledWith('week')
    expect(host.querySelector('.tiempo-range[aria-pressed="true"]')?.textContent).toBe('Semana')
  })

  it('falls back to bita when Jira is not installed', async () => {
    bita.toolsStatus.mockResolvedValue({ modules: { jira: false } })
    section.mount(host, ['hoy'])
    await flush()
    expect(bita.timeSummary).not.toHaveBeenCalled()
    expect(bita.worked).toHaveBeenCalledWith('today')
    expect(texts(host, '.tiempo-figure')).toEqual(['0:10'])
  })

  it('mounts the reports once for the month and switches them to a custom range', async () => {
    section.mount(host, ['mes'])
    expect(reports.mountReports).toHaveBeenCalledTimes(1)
    expect(reports.mountReports.mock.calls[0]?.[1]).toBe('month')
    const reportsHost = host.querySelector<HTMLElement>('#reportes')
    expect(reportsHost?.hidden).toBe(false)
    expect(host.querySelector<HTMLElement>('.tiempo-body')?.hidden).toBe(true)
    const form = host.querySelector<HTMLFormElement>('.tiempo-span')
    expect(form?.hidden).toBe(true)
    section.update(['rango'])
    expect(reports.mountReports).toHaveBeenCalledTimes(1)
    expect(reports.choose).toHaveBeenCalledWith('custom')
    expect(form?.hidden).toBe(false)
    const from = host.querySelector<HTMLInputElement>('[data-key="span-from"]')
    const to = host.querySelector<HTMLInputElement>('[data-key="span-to"]')
    expect([from?.value, to?.value]).toEqual(['2026-10-01', '2026-10-07'])
    if (from !== null) from.value = '2026-09-01'
    form?.requestSubmit()
    expect(reports.span).toHaveBeenCalledWith('2026-09-01', '2026-10-07')
    section.receive({ type: 'hidden' })
    expect(reports.conceal).toHaveBeenCalledTimes(1)
    section.update(['hoy'])
    await flush()
    expect(reportsHost?.hidden).toBe(true)
    expect(form?.hidden).toBe(true)
    section.unmount()
    expect(reports.dispose).toHaveBeenCalledTimes(1)
  })

  it('navigates with the range buttons', () => {
    section.mount(host, [])
    host.querySelector<HTMLButtonElement>('.tiempo-range[data-range="mes"]')?.click()
    expect(location.hash).toBe('#/tiempo/mes')
  })

  it('walks Hoy, Semana, Mes and Rango marking exactly one range at a time', async () => {
    section.mount(host, [])
    await flush()
    const pressed = (): string[] =>
      [...host.querySelectorAll('.tiempo-range[aria-pressed="true"]')].map((button) => button.textContent ?? '')
    expect(pressed()).toEqual(['Hoy'])
    section.update(['semana'])
    await flush()
    expect(pressed()).toEqual(['Semana'])
    expect(host.querySelector<HTMLElement>('.tiempo-body')?.hidden).toBe(false)
    section.update(['mes'])
    expect(pressed()).toEqual(['Mes'])
    expect(host.querySelector<HTMLElement>('#reportes')?.hidden).toBe(false)
    expect(host.querySelector<HTMLElement>('.tiempo-span')?.hidden).toBe(true)
    section.update(['rango'])
    expect(pressed()).toEqual(['Rango'])
    expect(host.querySelector<HTMLElement>('.tiempo-span')?.hidden).toBe(false)
    section.update(['hoy'])
    await flush()
    expect(pressed()).toEqual(['Hoy'])
    expect(host.querySelector<HTMLElement>('.tiempo-span')?.hidden).toBe(true)
    expect(host.querySelector<HTMLElement>('.tiempo-body')?.hidden).toBe(false)
    expect(host.querySelector('.tiempo')?.getAttribute('data-range')).toBe('hoy')
  })

  it('falls back to Hoy on an unknown range', async () => {
    section.mount(host, ['trimestre'])
    await flush()
    expect(bita.timeSummary).toHaveBeenCalledWith('today')
    expect(host.querySelector('.tiempo-range[aria-pressed="true"]')?.textContent).toBe('Hoy')
  })

  it('drops a slow week answer that arrives after the user went back to today', async () => {
    let releaseWeek: (value: unknown) => void = () => undefined
    const today = await bita.timeSummary()
    bita.timeSummary.mockReset()
    bita.timeSummary.mockImplementation((which: string) =>
      which === 'week'
        ? new Promise((done) => (releaseWeek = done))
        : Promise.resolve({ ...today, groups: [{ ...today.groups[0], summary: 'De hoy' }] }),
    )
    section.mount(host, ['semana'])
    await flush()
    section.update(['hoy'])
    await flush()
    releaseWeek({ ...today, groups: [{ ...today.groups[0], summary: 'De la semana' }] })
    await flush()
    expect(texts(host, '.tiempo-row:not(.tiempo-row--head) .tiempo-title')).toEqual(['De hoy'])
  })

  it('does not ask the reports for a range with empty dates', async () => {
    reports.current.mockReturnValue({ preset: 'custom', from: '', to: '' })
    section.mount(host, ['rango'])
    host.querySelector<HTMLFormElement>('.tiempo-span')?.requestSubmit()
    expect(reports.span).not.toHaveBeenCalled()
  })

  it('does not touch the reports for Hoy or Semana', async () => {
    section.mount(host, ['hoy'])
    section.update(['semana'])
    await flush()
    expect(reports.mountReports).not.toHaveBeenCalled()
    expect(() => section.receive({ type: 'hidden' })).not.toThrow()
  })

  it('shows the problem when neither Jira nor bita can answer', async () => {
    bita.toolsStatus.mockResolvedValue({ modules: { jira: false } })
    bita.worked.mockRejectedValue(new Error('sin bita'))
    section.mount(host, ['hoy'])
    await flush()
    expect(host.querySelector('.problem-message')?.textContent).toContain('sin bita')
    expect(texts(host, '.tiempo-figure')).toEqual([])
  })

  it('falls back to bita figures with a note when Jira fails', async () => {
    bita.timeSummary.mockRejectedValue(new Error('jira caido'))
    section.mount(host, ['semana'])
    await flush()
    expect(host.textContent).toContain('Sin datos de Jira')
    expect(bita.worked).toHaveBeenCalledWith('week')
  })

  it('starts clean when mounted again after an unmount', async () => {
    section.mount(host, ['mes'])
    section.unmount()
    section.mount(host, [])
    await flush()
    expect(host.querySelectorAll('.tiempo')).toHaveLength(1)
    expect(host.querySelector('.tiempo-range[aria-pressed="true"]')?.textContent).toBe('Hoy')
    expect(reports.dispose).toHaveBeenCalledTimes(1)
  })
})
