import type {
  MeetingRecord,
  MeetingSegment,
  MeetingSummary,
  MeetingTranscript,
  PageMeeting,
  PageNode,
  Space,
  ToolsStatus,
} from '../../bita.ts'
import { ENTRY, MINUTES_TAB, meetingRoute as linkToMeeting, pageRoute, positiveId } from '../../shell/links.ts'

export const TRANSCRIPT_CAPABILITY = 'meeting.transcript.json'
export const SUMMARY_CAPABILITY = 'meeting.summary.json'
export const LIVE_ID = 'live'
export const ALL_PROJECTS = ''
export const NO_PROJECT = 'Sin proyecto'

const DAY_MS = 86_400_000
const PARAGRAPH_GAP_MS = 4_000
const PARAGRAPH_SPAN_MS = 30_000
const CHANNEL_LABEL: Record<string, string> = { mic: 'Sala', system: 'Remotos' }

export type PastTab = 'minuta' | 'transcripcion' | 'grabacion'
export const PAST_TABS: readonly PastTab[] = ['minuta', 'transcripcion', 'grabacion']

export interface Place {
  projectName: string | null
  projectSlug: string
  pageId: number
  trail: string[]
}

export interface MeetingRow {
  id: string
  title: string
  startedAt: string
  durationSeconds: number
  entryId: number | null
  project: string
  mode: string
  hasVideo: boolean
  live: boolean
  place: Place | null
}

export interface LiveSummary {
  meetingId: string
  title: string | null
  project: string | null
  startedAt: string | null
  entryId: number | null
  mode: string | null
}

export interface MeetingGroup {
  label: string
  rows: MeetingRow[]
}

export interface TranscriptLine {
  startMs: number
  channel: string
  who: string
  text: string
}

export interface MeetingRoute {
  id: string | null
  entryId: number | null
  tab: PastTab
}

export function parseMeetingRoute(path: readonly string[]): MeetingRoute {
  const [id, tab] = path
  if (id === ENTRY) return { id: null, entryId: positiveId(tab), tab: 'minuta' }
  const known = PAST_TABS.find((candidate) => candidate === tab)
  return { id: id === undefined || id === '' ? null : id, entryId: null, tab: known ?? 'minuta' }
}

export function meetingRoute(id: string, tab: PastTab = 'minuta'): string {
  return linkToMeeting(id, id === LIVE_ID ? MINUTES_TAB : tab)
}

export function kindOfMode(mode: string | null | undefined): string {
  if (mode === 'remote') return 'remote-meeting'
  if (mode === 'in-person') return 'in-person-meeting'
  return 'meeting'
}

export function hasCapability(status: ToolsStatus | null, capability: string): boolean {
  const recap = status?.tools.find((tool) => tool.name === 'recap')
  return recap !== undefined && recap.state === 'ready' && recap.capabilities.includes(capability)
}

export function placeIndex(spaces: Space[] | undefined): Map<number, Place> {
  const index = new Map<number, Place>()
  for (const space of spaces ?? []) {
    const walk = (pages: PageNode[], trail: string[]): void => {
      for (const page of pages) {
        for (const meeting of page.meetings ?? []) {
          if (!index.has(meeting.entryId)) {
            index.set(meeting.entryId, {
              projectName: space.projectName,
              projectSlug: space.projectSlug,
              pageId: page.pageId,
              trail: [...trail, page.title],
            })
          }
        }
        walk(page.children ?? [], [...trail, page.title])
      }
    }
    walk(space.pages, [space.projectName ?? space.projectSlug])
  }
  return index
}

function startOf(record: MeetingRecord): string {
  return record.startedAt ?? record.createdAt
}

export function meetingRows(
  records: MeetingRecord[],
  places: Map<number, Place>,
  live: LiveSummary | null,
): MeetingRow[] {
  const rows: MeetingRow[] = []
  if (live !== null) {
    rows.push({
      id: LIVE_ID,
      title: live.title ?? 'Reunión en curso',
      startedAt: live.startedAt ?? new Date().toISOString(),
      durationSeconds: 0,
      entryId: live.entryId,
      project: live.project ?? NO_PROJECT,
      mode: live.mode ?? 'meeting',
      hasVideo: false,
      live: true,
      place: null,
    })
  }
  for (const record of records) {
    if (live !== null && record.id === live.meetingId) continue
    const entryId = typeof record.bitaEntryId === 'number' ? record.bitaEntryId : null
    const place = entryId === null ? null : (places.get(entryId) ?? null)
    rows.push({
      id: record.id,
      title: record.title.trim().length > 0 ? record.title : 'Reunión sin título',
      startedAt: startOf(record),
      durationSeconds: record.durationSeconds ?? 0,
      entryId,
      project: place?.projectName ?? NO_PROJECT,
      mode: record.mode,
      hasVideo: record.hasVideo,
      live: false,
      place,
    })
  }
  return rows
}

export function projectsOf(rows: MeetingRow[]): string[] {
  return [...new Set(rows.map((row) => row.project))].sort((left, right) => {
    if (left === NO_PROJECT) return 1
    if (right === NO_PROJECT) return -1
    return left.localeCompare(right, 'es')
  })
}

export function weekStart(now: Date): Date {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const back = (start.getDay() + 6) % 7
  start.setDate(start.getDate() - back)
  return start
}

export function groupMeetings(rows: MeetingRow[], project: string, now: Date): MeetingGroup[] {
  const shown = rows.filter((row) => project === ALL_PROJECTS || row.project === project)
  const since = weekStart(now).getTime()
  const newest = (left: MeetingRow, right: MeetingRow): number => right.startedAt.localeCompare(left.startedAt)
  const past = shown.filter((row) => !row.live).sort(newest)
  const groups: MeetingGroup[] = [
    { label: 'En curso', rows: shown.filter((row) => row.live) },
    { label: 'Esta semana', rows: past.filter((row) => new Date(row.startedAt).getTime() >= since) },
    { label: 'Anteriores', rows: past.filter((row) => !(new Date(row.startedAt).getTime() >= since)) },
  ]
  return groups.filter((group) => group.rows.length > 0)
}

export function durationText(seconds: number): string {
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}`
}

export function dayText(iso: string, now: Date): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso.slice(0, 10)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const days = Math.round((today - day) / DAY_MS)
  if (days === 0) return 'hoy'
  if (days === 1) return 'ayer'
  if (days > 1 && days < 7) return date.toLocaleDateString('es-MX', { weekday: 'short' }).replace('.', '')
  return date.toLocaleDateString('es-MX', { day: 'numeric', month: 'short' }).replace('.', '')
}

export function rowMeta(row: MeetingRow, now: Date): string {
  if (row.live) return `${row.project} · en curso`
  return `${row.project} · ${dayText(row.startedAt, now)} · ${durationText(row.durationSeconds)}`
}

export function mediaText(mode: string, hasVideo: boolean): string {
  if (mode === 'in-person') return 'presencial'
  return hasVideo ? 'audio y pantalla' : 'solo audio'
}

export function pageMeetingOf(row: MeetingRow): PageMeeting {
  return {
    entryId: row.entryId ?? 0,
    kind: kindOfMode(row.mode),
    startedAt: row.startedAt,
    stoppedAt: null,
    durationSeconds: row.durationSeconds,
  }
}

export function sectionText(markdown: string, heading: string): string {
  const wanted = heading.toLowerCase()
  const out: string[] = []
  let inside = false
  for (const line of markdown.split('\n')) {
    const match = /^#{1,3}\s+(.*\S)\s*$/.exec(line)
    if (match?.[1] !== undefined) {
      inside = match[1].toLowerCase().startsWith(wanted)
      continue
    }
    if (inside) out.push(line)
  }
  return out.join('\n').trim()
}

export function summaryText(summary: MeetingSummary): string {
  const section = sectionText(summary.markdown, 'Resumen')
  if (section.length > 0) return section
  const body = summary.markdown
    .split('\n')
    .filter((line) => !/^#{1,6}\s/.test(line))
    .join('\n')
    .trim()
  return body.split(/\n\s*\n/)[0]?.trim() ?? ''
}

export function channelName(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel
}

export function linesFromRecap(transcript: MeetingTranscript): TranscriptLine[] {
  if (transcript.paragraphs.length > 0) {
    return transcript.paragraphs.map((paragraph) => ({
      startMs: paragraph.startMs,
      channel: paragraph.channel,
      who: paragraph.speaker ?? channelName(paragraph.channel),
      text: paragraph.text,
    }))
  }
  return linesFromSegments(transcript.segments)
}

export function linesFromSegments(segments: MeetingSegment[]): TranscriptLine[] {
  const lines: TranscriptLine[] = []
  let lastEnd = Number.NEGATIVE_INFINITY
  let lastStart = 0
  for (const segment of segments) {
    const last = lines.at(-1)
    if (
      last !== undefined &&
      last.channel === segment.channel &&
      segment.startMs - lastEnd <= PARAGRAPH_GAP_MS &&
      segment.startMs - lastStart < PARAGRAPH_SPAN_MS
    ) {
      last.text = `${last.text} ${segment.text}`
    } else {
      lines.push({ startMs: segment.startMs, channel: segment.channel, who: channelName(segment.channel), text: segment.text })
      lastStart = segment.startMs
    }
    lastEnd = Math.max(lastEnd, segment.endMs)
  }
  return lines
}

export function docRoute(place: Place): string {
  return pageRoute(place.pageId, place.projectSlug)
}

export function docPath(place: Place): string {
  return place.trail.join(' › ')
}
