import type { ToolsStatus } from '../../bita.ts'
import type { AgentInfo, HarnessId, SessionDirectory, SessionListing, SpawnRequest } from './api.ts'

export const HARNESSES: readonly { id: HarnessId; label: string }[] = [
  { id: 'claude', label: 'Claude' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini' },
]

export const REQUIRED_CAPABILITIES = ['sessions.list', 'sessions.dirs', 'work.resume.session', 'work.prompt'] as const

export const NO_PROJECT = '0'

export type Pane = 'terminal' | 'activity'

// TODO(6b): switch to 'activity' once the activity pane shows agent events
export const DEFAULT_PANE: Pane = 'terminal'

export type Readiness =
  | { kind: 'unknown' }
  | { kind: 'ready' }
  | { kind: 'missing'; install: string }
  | { kind: 'outdated'; install: string; lacking: string[] }

export function readiness(tools: ToolsStatus | null): Readiness {
  if (tools === null) return { kind: 'unknown' }
  const bita = tools.tools.find((tool) => tool.name === 'bita')
  const install = bita?.install ?? 'npm install -g @kikedealba/bita && bita setup'
  if (bita === undefined || bita.state !== 'ready') return { kind: 'missing', install }
  const lacking = REQUIRED_CAPABILITIES.filter((capability) => !bita.capabilities.includes(capability))
  return lacking.length === 0 ? { kind: 'ready' } : { kind: 'outdated', install, lacking }
}

export function harnessLabel(id: string | null): string {
  return HARNESSES.find((harness) => harness.id === id)?.label ?? id ?? 'Agente'
}

export type AgentesView =
  | { kind: 'session'; id: number | null }
  | { kind: 'mosaic' }
  | { kind: 'new' }
  | { kind: 'entry'; entryId: number }

export const NEW_PATH = 'nueva'
export const MOSAIC_PATH = 'mosaico'
export const ENTRY_PATH = 'entry'

function positive(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text)) return null
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

export function parseAgentesPath(path: readonly string[]): AgentesView {
  const [head, second] = path
  if (head === NEW_PATH) return { kind: 'new' }
  if (head === MOSAIC_PATH) return { kind: 'mosaic' }
  if (head === ENTRY_PATH) {
    const entryId = positive(second)
    if (entryId !== null) return { kind: 'entry', entryId }
  }
  return { kind: 'session', id: positive(head) }
}

export function agentesRoute(view: AgentesView): string {
  switch (view.kind) {
    case 'new':
      return `agentes/${NEW_PATH}`
    case 'mosaic':
      return `agentes/${MOSAIC_PATH}`
    case 'entry':
      return `agentes/${ENTRY_PATH}/${view.entryId}`
    case 'session':
      return view.id === null ? 'agentes' : `agentes/${view.id}`
  }
}

export function sessionForEntry(sessions: readonly AgentInfo[], entryId: number): AgentInfo | null {
  const matches = sessions.filter((session) => session.bita?.entryId === entryId)
  return matches.find((session) => session.alive) ?? matches.at(-1) ?? null
}

function firstLine(text: string, limit: number): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line
}

export function sessionTitle(session: AgentInfo): string {
  const described = session.bita?.entry.description.trim()
  if (described !== undefined && described !== '') return described
  if (session.title !== null && session.title.trim() !== '') return session.title.trim()
  if (session.prompt !== null && session.prompt.trim() !== '') return firstLine(session.prompt, 48)
  return 'Sin nombre todavía'
}

export function elapsed(startedAt: string, now: Date): number {
  const start = Date.parse(startedAt)
  if (Number.isNaN(start)) return 0
  return Math.max(0, Math.floor((now.getTime() - start) / 1000))
}

export function shortClock(seconds: number): string {
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return `${hours}:${String(minutes).padStart(2, '0')}`
}

export function shortPath(path: string): string {
  const parts = path.split('/').filter((part) => part !== '' && part !== '~')
  return parts.slice(-2).join('/') || path
}

export function projectArg(project: string | null, folder: SessionDirectory | null): string {
  if (project !== null && project !== '') return project
  if (folder?.projectId !== null && folder?.projectId !== undefined) return String(folder.projectId)
  return NO_PROJECT
}

export function sessionMeta(session: AgentInfo, projectName: (id: string | null) => string): string {
  const harness = harnessLabel(session.bita?.harness ?? session.harness)
  const project = session.bita?.entry.projectName ?? projectName(session.project)
  const parts = [harness, project]
  if (session.cwd !== null) parts.push(shortPath(session.bita?.cwd ?? session.cwd))
  return parts.join(' · ')
}

function quote(argument: string): string {
  if (/^[\w@%+=:,./-]+$/.test(argument)) return argument
  return `'${argument.replaceAll("'", `'\\''`)}'`
}

export function commandPreview(request: SpawnRequest): string {
  const parts = ['bita', 'work']
  if (request.resumeSession !== undefined) {
    parts.push('--resume', '--session', String(request.resumeSession))
  } else {
    parts.push('--harness', request.harness ?? 'claude', `--project=${request.project ?? NO_PROJECT}`)
  }
  const prompt = request.prompt?.trim() ?? ''
  if (prompt !== '') parts.push(`--prompt=${request.prompt ?? ''}`)
  return parts.map(quote).join(' ')
}

export function resumable(listings: readonly SessionListing[]): SessionListing[] {
  return listings.filter((listing) => listing.resumable && !listing.open)
}

function sameDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate()
}

const WEEKDAYS = ['dom', 'lun', 'mar', 'mié', 'jue', 'vie', 'sáb']

export function dayLabel(iso: string, now: Date): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  if (sameDay(date, now)) return 'hoy'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (sameDay(date, yesterday)) return 'ayer'
  const age = (now.getTime() - date.getTime()) / 86_400_000
  if (age > 0 && age < 7) return WEEKDAYS[date.getDay()] ?? ''
  return `${date.getDate()}/${date.getMonth() + 1}`
}

export function timeLabel(iso: string, now: Date): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  return `${dayLabel(iso, now)} ${time}`
}

export function duration(listing: SessionListing): string {
  if (listing.endedAt === null) return ''
  const seconds = Math.max(0, Math.floor((Date.parse(listing.endedAt) - Date.parse(listing.startedAt)) / 1000))
  return Number.isNaN(seconds) ? '' : shortClock(seconds)
}

export function sessionsWord(count: number): string {
  return count === 1 ? '1 sesión' : `${count} sesiones`
}

export function folderMeta(folder: SessionDirectory): string {
  return `${folder.projectName ?? 'sin proyecto'} · ${sessionsWord(folder.sessions)}`
}

export function resumeMeta(listing: SessionListing, now: Date): string {
  const parts = [harnessLabel(listing.harness), listing.entry.projectName ?? 'sin proyecto', timeLabel(listing.startedAt, now)]
  const length = duration(listing)
  if (length !== '') parts.push(length)
  return parts.join(' · ')
}

export function resumeTitle(listing: SessionListing): string {
  const text = listing.entry.description.trim()
  return text === '' ? 'Sin título' : text
}
