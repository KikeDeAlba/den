import { describe, expect, it } from 'vitest'
import type { Group, SummaryView, WorkedView } from '../../bita.ts'
import {
  excludedLine,
  hoursMinutes,
  isTable,
  rangeOf,
  stateLabel,
  tallyTable,
  unregisteredLine,
  workedTable,
} from './rows.ts'

function group(partial: Partial<Group> & Pick<Group, 'summary' | 'entryIds'>): Group {
  return {
    projectId: 7,
    projectName: 'Viva Cash',
    totalSeconds: 0,
    totalHuman: '',
    estimateSeconds: 0,
    estimateHuman: '',
    days: ['2026-10-24'],
    partIndex: 1,
    partCount: 1,
    jiraProjectKey: 'VC',
    jira: true,
    ...partial,
  }
}

function summary(groups: Group[]): SummaryView {
  return {
    totalSeconds: groups.reduce((sum, item) => sum + item.totalSeconds, 0),
    totalHuman: '',
    jiraSeconds: 0,
    nonJiraSeconds: 0,
    nonJira: null,
    estimateSeconds: groups.filter((item) => item.jira).reduce((sum, item) => sum + item.estimateSeconds, 0),
    groups,
    overlaps: [{ localDay: '2026-10-24', trackedSeconds: 3600, clockSeconds: 3000, overlapSeconds: 600 }],
    excluded: [
      { id: 9, description: '', projectName: null, durationHuman: '5m', reason: 'no-description' },
      { id: 10, description: '', projectName: null, durationHuman: '1m', reason: 'no-description' },
    ],
  }
}

describe('tiempo ranges', () => {
  it('reads the range from the route and falls back to today', () => {
    expect(rangeOf(['semana'])).toBe('semana')
    expect(rangeOf(['mes', 'extra'])).toBe('mes')
    expect(rangeOf([])).toBe('hoy')
    expect(rangeOf(['nope'])).toBe('hoy')
  })

  it('shows the table for today and the week and the reports for month and range', () => {
    expect(isTable('hoy')).toBe(true)
    expect(isTable('semana')).toBe(true)
    expect(isTable('mes')).toBe(false)
    expect(isTable('rango')).toBe(false)
  })
})

describe('hoursMinutes', () => {
  it('formats seconds as h:mm and floors partial minutes', () => {
    expect(hoursMinutes(0)).toBe('0:00')
    expect(hoursMinutes(59)).toBe('0:00')
    expect(hoursMinutes(8040)).toBe('2:14')
    expect(hoursMinutes(36000)).toBe('10:00')
    expect(hoursMinutes(-5)).toBe('0:00')
  })
})

describe('tallyTable', () => {
  const data = summary([
    group({ summary: 'Revisar el MR', entryIds: [1, 2, 3], totalSeconds: 8040, estimateSeconds: 9000, issueKey: 'VC-212' }),
    group({ summary: 'Daily Viva', entryIds: [4], totalSeconds: 1440, estimateSeconds: 1800, issueKey: 'VC-200', kind: 'remote-meeting' }),
    group({ summary: 'Corriendo', entryIds: [5], totalSeconds: 600, estimateSeconds: 1800, issueKey: null }),
    group({
      summary: 'Soporte a QA',
      entryIds: [6],
      projectId: null,
      projectName: null,
      totalSeconds: 2100,
      estimateSeconds: 0,
      jira: false,
      days: ['2026-10-20', '2026-10-22'],
    }),
  ])
  const table = tallyTable(data, new Set([1, 2, 99]), new Set([5]))

  it('keeps the per-task estimate tally rounded and sums those for the total', () => {
    expect(table.rows.map((row) => row.estimateSeconds)).toEqual([9000, 1800, 1800, null])
    expect(table.estimateSeconds).toBe(12600)
    expect(table.workedSeconds).toBe(12180)
  })

  it('takes the issue key and the Jira state of each task', () => {
    expect(table.rows.map((row) => row.issueKey)).toEqual(['VC-212', 'VC-200', null, null])
    expect(table.rows.map((row) => row.state)).toEqual(['pending', 'registered', 'running', 'outside'])
    expect(table.rows.map(stateLabel)).toEqual(['2 sin registrar', 'registrado', 'en curso', 'fuera de Jira'])
  })

  it('describes blocks, running timers, meetings and day spans', () => {
    expect(table.rows.map((row) => row.meta)).toEqual([
      '3 bloques',
      '1 bloque · reunión',
      '1 bloque · corriendo',
      '1 bloque · 10-20–10-22',
    ])
    expect(table.rows[3]?.project).toBe('sin proyecto')
  })

  it('counts the worklogs still missing in Jira', () => {
    expect(table.unregistered).toBe(2)
    expect(table.unregisteredTasks).toBe(1)
    expect(unregisteredLine(table)).toBe('2 worklogs sin registrar en 1 tarea · escribir en Jira lo hace Claude')
  })

  it('carries overlaps and the entries left out', () => {
    expect(table.overlaps).toHaveLength(1)
    expect(excludedLine(table.excluded)).toBe('Quedan fuera 2: 2 sin título.')
  })

  it('leaves the state unknown when the pending list could not be read', () => {
    const blind = tallyTable(data, null, new Set())
    expect(blind.rows.map((row) => row.state)).toEqual(['unknown', 'unknown', 'unknown', 'outside'])
    expect(blind.unregistered).toBe(0)
  })

  it('says everything is in Jira when nothing is pending', () => {
    expect(unregisteredLine(tallyTable(data, new Set(), new Set()))).toBe('Todo lo de este rango ya está en Jira.')
  })
})

describe('workedTable', () => {
  it('falls back to what bita measured, without estimate or Jira', () => {
    const worked: WorkedView = {
      totalSeconds: 4000,
      groups: [
        { summary: 'Rediseño de Den', projectId: 3, projectName: 'den', totalSeconds: 4000, entryIds: [1, 2], days: ['2026-10-24'], running: true },
      ],
      overlaps: [],
    }
    const table = workedTable(worked)
    expect(table.jira).toBe(false)
    expect(table.estimateSeconds).toBeNull()
    expect(table.rows[0]).toMatchObject({ meta: '2 bloques · corriendo', estimateSeconds: null, issueKey: null, state: 'unknown' })
    expect(stateLabel(table.rows[0]!)).toBe('')
    expect(unregisteredLine(table)).toBeNull()
  })
})
