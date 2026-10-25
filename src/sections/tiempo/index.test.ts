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
    reports.mountReports.mockReturnValue({ choose: reports.choose, dispose: reports.dispose })
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
    section.update(['rango'])
    expect(reports.mountReports).toHaveBeenCalledTimes(1)
    expect(reports.choose).toHaveBeenCalledWith('custom')
    section.update(['hoy'])
    await flush()
    expect(reportsHost?.hidden).toBe(true)
    section.unmount()
    expect(reports.dispose).toHaveBeenCalledTimes(1)
  })

  it('navigates with the range buttons', () => {
    section.mount(host, [])
    host.querySelector<HTMLButtonElement>('.tiempo-range[data-range="mes"]')?.click()
    expect(location.hash).toBe('#/tiempo/mes')
  })
})
