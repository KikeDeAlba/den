import { describe, expect, it } from 'vitest'

import type { MeetingRecord, PageNode, Space, ToolsStatus } from '../../bita.ts'
import {
  ALL_PROJECTS,
  LIVE_ID,
  NO_PROJECT,
  SUMMARY_CAPABILITY,
  docRoute,
  groupMeetings,
  hasCapability,
  kindOfMode,
  linesFromRecap,
  linesFromSegments,
  meetingRoute,
  meetingRows,
  parseMeetingRoute,
  placeIndex,
  projectsOf,
  summaryText,
  weekStart,
} from './model.ts'

const NOW = new Date(2026, 9, 22, 12, 0)

function record(id: string, startedAt: string, extra: Partial<MeetingRecord> = {}): MeetingRecord {
  return {
    id,
    title: id,
    mode: 'meeting',
    status: 'done',
    createdAt: startedAt,
    startedAt,
    durationSeconds: 600,
    dir: `/m/${id}`,
    hasVideo: false,
    storage: { recordingBytes: 0, intermediateBytes: 0, framesBytes: 0, otherBytes: 0, totalBytes: 0 },
    ...extra,
  }
}

function page(pageId: number, title: string, entryIds: number[], children: PageNode[] = []): PageNode {
  return {
    pageId,
    title,
    meetings: entryIds.map((entryId) => ({ entryId, kind: 'meeting', startedAt: '', stoppedAt: null, durationSeconds: 0 })),
    children,
  } as unknown as PageNode
}

const spaces = [
  { projectId: 1, projectName: 'Viva Cash', projectSlug: 'viva-cash', active: true, entryCount: 0, pageCount: 0, pages: [page(10, 'Reuniones', [], [page(11, 'Sprint', [7])])] },
] as Space[]

describe('routes', () => {
  it('reads the meeting and the tab from the path', () => {
    expect(parseMeetingRoute([])).toEqual({ id: null, tab: 'minuta' })
    expect(parseMeetingRoute(['abc', 'transcripcion'])).toEqual({ id: 'abc', tab: 'transcripcion' })
    expect(parseMeetingRoute(['abc', 'nope'])).toEqual({ id: 'abc', tab: 'minuta' })
  })

  it('writes the route back', () => {
    expect(meetingRoute('abc')).toBe('reuniones/abc')
    expect(meetingRoute('abc', 'grabacion')).toBe('reuniones/abc/grabacion')
    expect(meetingRoute(LIVE_ID, 'grabacion')).toBe('reuniones/live')
  })
})

describe('kindOfMode', () => {
  it('maps recap modes to bita kinds', () => {
    expect(kindOfMode('remote')).toBe('remote-meeting')
    expect(kindOfMode('in-person')).toBe('in-person-meeting')
    expect(kindOfMode('meeting')).toBe('meeting')
    expect(kindOfMode(null)).toBe('meeting')
  })
})

describe('hasCapability', () => {
  it('needs recap ready and announcing the capability', () => {
    const status = (state: string, capabilities: string[]) =>
      ({ tools: [{ name: 'recap', state, capabilities }] }) as unknown as ToolsStatus
    expect(hasCapability(status('ready', [SUMMARY_CAPABILITY]), SUMMARY_CAPABILITY)).toBe(true)
    expect(hasCapability(status('missing', [SUMMARY_CAPABILITY]), SUMMARY_CAPABILITY)).toBe(false)
    expect(hasCapability(status('ready', []), SUMMARY_CAPABILITY)).toBe(false)
    expect(hasCapability(null, SUMMARY_CAPABILITY)).toBe(false)
  })
})

describe('meeting rows', () => {
  const places = placeIndex(spaces)

  it('finds the space and page of each bita entry', () => {
    expect(places.get(7)).toEqual({ projectName: 'Viva Cash', projectSlug: 'viva-cash', pageId: 11, trail: ['Viva Cash', 'Reuniones', 'Sprint'] })
    expect(docRoute(places.get(7)!)).toBe('docs/viva-cash/11')
  })

  it('puts the live meeting first and drops its recap record', () => {
    const rows = meetingRows(
      [record('now', '2026-10-22T11:00:00'), record('old', '2026-10-01T10:00:00', { bitaEntryId: 7 })],
      places,
      { meetingId: 'now', title: 'Daily', project: 'Viva Cash', startedAt: '2026-10-22T11:00:00', entryId: 3, mode: 'meeting' },
    )
    expect(rows.map((row) => row.id)).toEqual([LIVE_ID, 'old'])
    expect(rows[0]?.live).toBe(true)
    expect(rows[1]?.project).toBe('Viva Cash')
  })

  it('groups by in progress, this week and older, and filters by project', () => {
    const rows = meetingRows(
      [
        record('mon', '2026-10-19T09:00:00', { bitaEntryId: 7 }),
        record('sun', '2026-10-18T09:00:00'),
        record('tue', '2026-10-20T09:00:00'),
      ],
      places,
      { meetingId: 'x', title: null, project: null, startedAt: null, entryId: null, mode: null },
    )
    const groups = groupMeetings(rows, ALL_PROJECTS, NOW)
    expect(groups.map((group) => [group.label, group.rows.map((row) => row.id)])).toEqual([
      ['En curso', [LIVE_ID]],
      ['Esta semana', ['tue', 'mon']],
      ['Anteriores', ['sun']],
    ])
    expect(groupMeetings(rows, 'Viva Cash', NOW).map((group) => group.rows.map((row) => row.id))).toEqual([['mon']])
    expect(projectsOf(rows)).toEqual(['Viva Cash', NO_PROJECT])
  })

  it('starts the week on monday', () => {
    expect(weekStart(NOW)).toEqual(new Date(2026, 9, 19))
    expect(weekStart(new Date(2026, 9, 25, 23))).toEqual(new Date(2026, 9, 19))
  })
})

describe('minutes and transcript', () => {
  it('takes the summary section or the first paragraph', () => {
    expect(summaryText({ markdown: '# T\n\n## Resumen\nTodo bien.\n\n## Acuerdos\n1. x', agreements: [], actionItems: [] })).toBe('Todo bien.')
    expect(summaryText({ markdown: '# T\n\nPrimero.\n\nSegundo.', agreements: [], actionItems: [] })).toBe('Primero.')
  })

  it('prefers the recap speaker and falls back to the channel', () => {
    const lines = linesFromRecap({
      segments: [],
      paragraphs: [
        { startMs: 0, channel: 'mic', speaker: 'Ana', text: 'Hola' },
        { startMs: 5000, channel: 'system', speaker: null, text: 'Buenas' },
      ],
      channels: null,
    })
    expect(lines.map((line) => line.who)).toEqual(['Ana', 'Remotos'])
  })

  it('joins close segments of the same channel', () => {
    const lines = linesFromSegments([
      { startMs: 0, endMs: 1000, channel: 'mic', text: 'a' },
      { startMs: 2000, endMs: 3000, channel: 'mic', text: 'b' },
      { startMs: 3500, endMs: 4000, channel: 'system', text: 'c' },
      { startMs: 20000, endMs: 21000, channel: 'system', text: 'd' },
    ])
    expect(lines.map((line) => line.text)).toEqual(['a b', 'c', 'd'])
  })
})
