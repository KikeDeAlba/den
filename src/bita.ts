import { convertFileSrc, invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { getCurrentWindow } from '@tauri-apps/api/window'

export const SNAPSHOT_EVENT = 'bita://snapshot'
export const DOCS_CHANGED_EVENT = 'bita://docs-changed'
export const MEETING_MEDIA_EVENT = 'bita://meeting-media-changed'
export const SYNC_FINISHED_EVENT = 'bita://confluence-synced'
export const LIVE_ANSWER_EVENT = 'bita://live-answer'
export const LIVE_STATE_EVENT = 'bita://live-state'
export const LIVE_TRANSCRIPT_EVENT = 'bita://live-transcript'
export const CLOSE_REQUESTED_EVENT = 'tauri://close-requested'
export const NAVIGATE_EVENT = 'den://navigate'
export const TOOLS_EVENT = 'bita://tools-changed'

export type ProblemKind =
  | 'tool-missing'
  | 'cli-too-old'
  | 'schema-mismatch'
  | 'cli-failed'
  | 'unreadable'

export interface Problem {
  kind: ProblemKind
  message: string
  hint: string | null
}

export interface LiveTimer {
  id: number
  title: string | null
  docRelPath: string | null
  sectionsWritten: number | null
  sectionsTotal: number | null
  touchedSinceNote: number | null
  projectName: string | null
  projectId: number | null
  startedAt: string
  startLocal: string
  elapsedSeconds: number
  draft: boolean
  kind: string | null
}

export const MEETING_KINDS = {
  meeting: 'Reunión',
  'remote-meeting': 'Reunión remota',
  'in-person-meeting': 'Reunión presencial',
} as const

export type MeetingKind = keyof typeof MEETING_KINDS

export function isMeetingKind(value: string | null): value is MeetingKind {
  return value !== null && Object.hasOwn(MEETING_KINDS, value)
}

export interface Snapshot {
  running: LiveTimer[]
  todaySeconds: number
  problem: Problem | null
}

export interface Project {
  id: number
  name: string
  active: boolean
  key?: string | null
  clientName: string | null
  jiraProjectKey?: string | null
  jira?: boolean | null
}

export interface JiraProject {
  projectId: number
  jiraProjectKey: string | null
  jira: boolean
}

export function jiraProjects(): Promise<JiraProject[]> {
  return invoke<JiraProject[]>('jira_projects')
}

export function jiraKeyMap(list: JiraProject[]): Map<number, string> {
  return new Map(
    list.filter((row) => row.jiraProjectKey !== null).map((row) => [row.projectId, row.jiraProjectKey as string]),
  )
}

export function noJiraSet(list: JiraProject[]): Set<number> {
  return new Set(list.filter((row) => !row.jira).map((row) => row.projectId))
}

export function snapshot(): Promise<Snapshot> {
  return invoke<Snapshot>('snapshot')
}

export function refresh(): Promise<Snapshot> {
  return invoke<Snapshot>('refresh')
}

export function projects(): Promise<Project[]> {
  return invoke<Project[]>('projects')
}

export function startTimer(
  title: string | null,
  project: string | null,
  kind: string | null = null,
): Promise<Snapshot> {
  return invoke<Snapshot>('start_timer', { title, project, kind })
}

export function stopTimer(id: number): Promise<Snapshot> {
  return invoke<Snapshot>('stop_timer', { id })
}

export function discardTimer(id: number): Promise<Snapshot> {
  return invoke<Snapshot>('discard_timer', { id })
}

export function amendTimer(
  id: number,
  title: string | null,
  project: string | null,
  kind: string | null = null,
): Promise<Snapshot> {
  return invoke<Snapshot>('amend_timer', { id, title, project, kind })
}

export interface Group {
  summary: string
  projectId: number | null
  projectName: string | null
  totalSeconds: number
  totalHuman: string
  estimateSeconds: number
  estimateHuman: string
  entryIds: number[]
  days: string[]
  partIndex: number
  partCount: number
  jiraProjectKey: string | null
  jira: boolean
  issueKey?: string | null
  kind?: string | null
}

export interface NonJira {
  totalSeconds: number
  totalHuman: string
  projects: { name: string | null; totalSeconds: number; totalHuman: string }[]
}

export interface Overlap {
  localDay: string
  trackedSeconds: number
  clockSeconds: number
  overlapSeconds: number
}

export interface Excluded {
  id: number
  description: string
  projectName: string | null
  durationHuman: string
  reason: string
}

export interface SummaryView {
  totalSeconds: number
  totalHuman: string
  jiraSeconds: number
  nonJiraSeconds: number
  nonJira: NonJira | null
  estimateSeconds: number
  groups: Group[]
  overlaps: Overlap[]
  excluded: Excluded[]
}

export interface WorkedGroup {
  summary: string
  projectId: number | null
  projectName: string | null
  totalSeconds: number
  entryIds: number[]
  days: string[]
  running: boolean
}

export interface WorkedView {
  totalSeconds: number
  groups: WorkedGroup[]
  overlaps: Overlap[]
}

export interface Scope {
  prefix: string
  projectId: number
  projectName: string
  slugSource: string
}

export function worked(range: 'today' | 'week'): Promise<WorkedView> {
  return invoke<WorkedView>('worked', { range })
}

export function pending(): Promise<SummaryView> {
  return invoke<SummaryView>('pending')
}

export function timeSummary(range: 'today' | 'week'): Promise<SummaryView> {
  return invoke<SummaryView>('time_summary', { range })
}

export interface ReportRange {
  fromDay: string
  toDay: string
  timezone: string | null
  weekStartsOn: number | string | null
}

export interface ReportProject {
  projectId: number | null
  name: string
  clientName: string | null
  totalSeconds: number
  entryCount: number
  color: string
  jira: boolean
  registeredSeconds: number
  pendingSeconds: number
  excludedSeconds: number
}

export interface ProjectSeconds {
  projectId: number | null
  seconds: number
}

export interface ReportDay {
  day: string
  totalSeconds: number
  projects: ProjectSeconds[]
}

export interface ReportWeek {
  fromDay: string
  toDay: string
  totalSeconds: number
  projects: ProjectSeconds[]
}

export interface ReportEntry {
  id: number
  title: string
  projectId: number | null
  start: string
  stop: string | null
  localDay: string
  seconds: number
  kind: string | null
  overlapping: boolean
  blockIds: number[]
  color: string
  registered: boolean | null
  issueKey: string | null
  jira: boolean | null
  excludedReason: string | null
}

export interface JiraTotals {
  registeredSeconds: number
  pendingSeconds: number
  excludedSeconds: number
  nonJiraSeconds: number
  estimateSeconds?: number
}

export interface Pay {
  monthlySalary: number | null
  currency: string
  monthlyHours: number
  multiplier: number
  excludedProjects: number[]
}

export interface OvertimeProject {
  projectId: number | null
  name: string | null
  estimateSeconds: number
  counts: boolean
}

export interface OvertimeMonth {
  month: string
  from: string
  to: string
  partial: boolean
  estimateSeconds: number
  expectedSeconds: number
  overtimeSeconds: number
  payX1: number
  payMultiplied: number
  byProject: OvertimeProject[]
}

export interface OvertimeTotals {
  estimateSeconds: number
  expectedSeconds: number
  overtimeSeconds: number
  payX1: number
  payMultiplied: number
}

export interface Overtime {
  currency: string
  hourlyRate: number
  multiplier: number
  monthlyHours: number
  months: OvertimeMonth[]
  totals: OvertimeTotals
  problem: string | null
}

export interface ReportView {
  range: ReportRange
  totalSeconds: number
  entryCount: number
  activeDays: number
  projects: ReportProject[]
  days: ReportDay[]
  weeks: ReportWeek[]
  overlaps: Overlap[]
  entries: ReportEntry[] | null
  jiraAvailable: boolean
  jiraTotals: JiraTotals | null
  jiraProblem: string | null
  overtime: Overtime | null
}

export interface ReportRequest {
  preset?: string
  from?: string
  to?: string
  projectId?: number
  entries?: boolean
}

export function report(request: ReportRequest = {}): Promise<ReportView> {
  return invoke<ReportView>('report', { ...request })
}

export function getPay(): Promise<Pay> {
  return invoke<Pay>('get_pay')
}

export function setPay(pay: Pay): Promise<Pay> {
  return invoke<Pay>('set_pay', { pay })
}

export interface MenubarSettings {
  showLabel: boolean
  hideWhenIdle: boolean
}

export function menubarSettings(): Promise<MenubarSettings> {
  return invoke<MenubarSettings>('menubar_settings')
}

export function menubarSettingsSet(settings: MenubarSettings): Promise<MenubarSettings> {
  return invoke<MenubarSettings>('menubar_settings_set', { settings })
}

export function scopes(): Promise<Scope[]> {
  return invoke<Scope[]>('scopes')
}

export function addProject(name: string): Promise<Project[]> {
  return invoke<Project[]>('add_project', { name })
}

export function setScope(prefix: string, project: string): Promise<Scope[]> {
  return invoke<Scope[]>('set_scope', { prefix, project })
}

export function unsetScope(prefix: string): Promise<Scope[]> {
  return invoke<Scope[]>('unset_scope', { prefix })
}

export interface Check {
  id: string
  health: 'ok' | 'warn' | 'fail'
  title: string
  detail: string
  note: string | null
}

export interface InstallCard {
  tool: ToolName
  title: string
  purpose: string
  command: string
}

export interface Report {
  checks: Check[]
  install: InstallCard[]
  blocked: boolean
  tools: ToolsStatus
}

export function doctorReport(): Promise<Report> {
  return invoke<Report>('doctor_report')
}

export type ToolName = 'bita' | 'inkwell' | 'tally' | 'atl' | 'recap' | 'gaze'

export type ToolState = 'ready' | 'unresponsive' | 'broken-bin' | 'missing'

export interface ToolStatus {
  name: string
  known: boolean
  state: ToolState
  version: string | null
  capabilities: string[]
  verified: boolean
  origin: 'registry' | 'override' | null
  command: string | null
  manifest: string | null
  install: string
  purpose: string | null
}

export interface Modules {
  timers: boolean
  hoy: boolean
  jira: boolean
  notes: boolean
  entryNotes: boolean
  backlog: boolean
  history: boolean
  proposals: boolean
  atlassian: boolean
  confluenceSync: boolean
  meetings: boolean
  liveAssistant: boolean
  autoAsk: boolean
  meetingKinds: boolean
  graph: boolean
  graphSearch: boolean
}

export interface ToolsStatus {
  registryDir: string
  tools: ToolStatus[]
  invalid: { file: string; problems: string[] }[]
  modules: Modules
  inkwellMigrated: boolean | null
}

export const NO_MODULES: Modules = {
  timers: false,
  hoy: false,
  jira: false,
  notes: false,
  entryNotes: false,
  backlog: false,
  history: false,
  proposals: false,
  atlassian: false,
  confluenceSync: false,
  meetings: false,
  liveAssistant: false,
  autoAsk: false,
  meetingKinds: false,
  graph: false,
  graphSearch: false,
}

export function toolsStatus(refresh = false): Promise<ToolsStatus> {
  return invoke<ToolsStatus>('tools_status', { refresh })
}

export function onToolsChanged(handler: (status: ToolsStatus) => void): void {
  void listen<ToolsStatus>(TOOLS_EVENT, (event) => {
    handler(event.payload)
  })
}

export function installHint(status: ToolsStatus | null, tool: ToolName): string {
  return status?.tools.find((found) => found.name === tool)?.install ?? `npm install -g @kikedealba/${tool} && ${tool} setup`
}

export type SectionState = 'written' | 'empty' | 'absent'

export interface DocSection {
  heading: string
  state: SectionState
  canonical: boolean
}

export type DocFileStatus = 'ok' | 'changed' | 'missing' | 'unverified'

export interface DocFile {
  status: DocFileStatus
  path: string
  checksum: string | null
  recordedChecksum: string
  byteSize: number | null
  recordedByteSize: number
  mtime: string | null
}

export interface DocSummary {
  relPath: string
  path: string
  docTitle: string
  kind: string
  source: string
  sectionCount: number
  byteSize: number
  createdAt: string
  recordedAt: string
  repoSlug: string | null
  branch: string | null
  headSha: string | null
  appendixCount: number
  sections: DocSection[] | null
  file: DocFile
}

export interface NoteRow {
  entryId: number
  projectId: number | null
  projectName: string | null
  projectSlug: string
  title: string
  localDay: string
  month: string
  startLocal: string
  durationSeconds: number
  durationHuman: string
  running: boolean
  registered?: boolean
  issueKey?: string | null
  doc: DocSummary | null
}

export interface DocDetail extends DocSummary {
  frontMatter: Record<string, string>
  frontMatterValid: boolean
  preamble: string
  markdown: string | null
}

export interface NoteAppendix {
  relPath: string
  path: string
  title: string
  sectionCount: number
  byteSize: number
}

export interface NoteDocument extends Omit<NoteRow, 'doc'> {
  doc: DocDetail | null
  appendices: NoteAppendix[]
}

export interface TreeMonth {
  month: string
  entryCount: number
  docCount: number
}

export interface TreeProject {
  projectId: number | null
  projectName: string | null
  projectSlug: string
  active: boolean
  entryCount: number
  docCount: number
  appendixCount: number
  firstDay: string | null
  lastDay: string | null
  lastDocAt: string | null
  months: TreeMonth[]
}

export interface Coverage {
  projectCount: number
  entryCount: number
  entriesWithDoc: number
  docCount: number
  appendixCount: number
  firstEntryDay: string | null
  lastEntryDay: string | null
}

export interface TreeMeta {
  root: string
  timezone: string
  sections?: string[]
  layout?: 'legacy' | 'hierarchical'
  jira?: { siteUrl: string | null }
  totals: Coverage
}

export interface DocHeading {
  heading: string
  level: 2 | 3
  anchor: string
  order: number
  empty: boolean
}

export interface PageIssue {
  issueKey: string
  role: 'epic' | 'story' | 'task' | 'subtask'
  summary: string
  status: string
  statusCategory: '' | 'new' | 'indeterminate' | 'done'
  url: string | null
  refreshedAt: string | null
}

export interface PageMeeting {
  entryId: number
  kind: string
  startedAt: string
  stoppedAt: string | null
  durationSeconds: number
}

export interface MeetingSegment {
  startMs: number
  endMs: number
  channel: 'mic' | 'system' | string
  text: string
}

export interface MeetingFrame {
  timeSeconds: number
  src: string
}

export interface MeetingView {
  id: string
  title: string
  mode: 'remote' | 'in-person' | string
  status: string
  dir: string
  startedAt: string | null
  durationSeconds: number | null
  recording: string | null
  summaryMarkdown: string | null
  segments: MeetingSegment[]
  frames: MeetingFrame[]
  hasVideo: boolean
  storage: MeetingStorage | null
  video: MeetingVideoInfo | null
  videoRemovedAt: string | null
  answers: LiveAnswer[]
  proposals: Proposal[]
}

export type SourceKind = 'page' | 'file' | 'commit'

export interface AnswerSource {
  kind: SourceKind | string
  label: string
  pageId?: number
  path?: string
  line?: number
  repo?: string
  sha?: string
}

export interface LiveAnswer {
  id: string
  askedAt: string
  question: string
  answer: string
  found: boolean
  sources: AnswerSource[]
  auto?: boolean
  answeredAt?: string
  questionMs?: number
  channel?: 'mic' | 'system' | string
  askId?: string
}

export type StreamEvent =
  | { type: 'question'; text: string }
  | { type: 'progress'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'source'; source: AnswerSource }
  | { type: 'done'; answer: LiveAnswer }
  | { type: 'error'; code: string; message: string }

export interface LiveAnswerEvent {
  askId: number
  event: StreamEvent
}

export interface ActiveMeeting {
  meetingId: string
  dir: string
  mode: string | null
  startedAt: string | null
}

export type AskPhase = 'queued' | 'running'

export interface PendingAsk {
  id: string | null
  state: AskPhase
  auto: boolean
  question: string | null
  startedAt: string | null
  questionMs?: number
  channel?: 'mic' | 'system' | string
}

export interface LiveView {
  active: ActiveMeeting | null
  title: string | null
  entryId: number | null
  project: string | null
  transcript: MeetingSegment[]
  answers: LiveAnswer[]
  asking: boolean
  pendingAsks: PendingAsk[]
  shortcut: string
  visible: boolean
}

export interface LiveTranscriptUpdate {
  meetingId: string
  transcript: MeetingSegment[]
  from: number
  lines: MeetingSegment[]
  total: number
}

export interface LiveFullTranscript {
  meetingId: string
  transcript: MeetingSegment[]
}

export interface LiveConfig {
  enabled: boolean
  openWindow: boolean
  proposals: boolean
  assistModel: string | null
  maxChunkSeconds: number | null
  autoAsk: boolean | null
  autoAskModel: string | null
  autoAskMinSeconds: number | null
  autoAskConcurrency: number | null
}

export interface LiveSources {
  project: string
  docsRoot: string
  repos: { path: string; slug: string; exists: boolean }[]
}

export type ProposalStatus = 'pending' | 'accepted' | 'rejected' | 'stale'

export interface ProposalQuote {
  startMs: number
  channel: string | null
  text: string
}

export interface Proposal {
  n: number
  pageId: number
  pageTitle: string | null
  section: string | null
  title: string
  rationale: string | null
  quotes: ProposalQuote[]
  branch: string | null
  sha: string | null
  status: ProposalStatus | string
  appliedSha: string | null
  file?: string | null
  updatedAt?: string | null
}

export interface ProposalDetail {
  proposal: Proposal
  markdown: string | null
}

export interface DiffLine {
  kind: 'context' | 'add' | 'del' | string
  text: string
  oldLine: number | null
  newLine: number | null
}

export interface Hunk {
  header: string
  lines: DiffLine[]
}

export interface BranchCommit {
  sha: string
  pageId: number | null
  path: string | null
  reason: string | null
  hunks: Hunk[]
  diff: string
}

export interface BranchDiff {
  branch: string
  commits: BranchCommit[]
}

export type RevisionSource = 'manual' | 'meeting' | 'confluence-pull' | 'restore' | 'note' | 'import' | 'unknown'

export interface Revision {
  sha: string
  date: string
  subject: string
  source: RevisionSource | string
  reason: string | null
  entryId: number | null
}

export interface PageHistory {
  pageId: number
  path: string
  revisions: Revision[]
}

export interface PageDiff {
  pageId: number
  from: string
  to: string
  diff: string
  hunks: Hunk[]
}

export interface PendingMeeting {
  entryId: number
  meetingId: string | null
  title: string
  endedAt: string | null
  proposals: Proposal[]
}

export interface MeetingStorage {
  recordingBytes: number
  intermediateBytes: number
  framesBytes: number
  otherBytes: number
  totalBytes: number
}

export interface MeetingVideoInfo {
  compressedAt: string
  preset: CompressPreset
  originalBytes: number
}

export type CompressPreset = 'light' | 'medium' | 'max'

export interface MeetingRecord {
  id: string
  title: string
  mode: 'remote' | 'in-person' | string
  status: string
  createdAt: string
  startedAt?: string | null
  endedAt?: string | null
  durationSeconds?: number | null
  bitaEntryId?: number | null
  dir: string
  recording?: string | null
  transcript?: string | null
  summary?: string | null
  transcriptSegments?: string | null
  frames?: string | null
  hasVideo: boolean
  storage: MeetingStorage
  video?: MeetingVideoInfo | null
  videoRemovedAt?: string | null
}

export interface MeetingMediaChange {
  id: string
  ok: boolean
  error: string | null
  record: MeetingRecord | null
}

export interface MeetingDeleted {
  id: string
  dir: string
  freedBytes: number
}

export interface StorageReport {
  dbBytes: number
  docsBytes: number
  recapAvailable: boolean
  meetings: MeetingRecord[]
}

export interface TranscriptMatch {
  startMs: number | null
  prefix: string
  match: string
  suffix: string
}

export interface TranscriptHit {
  entryId: number
  meetingId: string
  matchCount: number
  matches: TranscriptMatch[]
}

export interface PageSearchMatch {
  source: 'page' | 'entry'
  entryId?: number
  section: string | null
  line: number
  prefix: string
  match: string
  suffix: string
}

export interface PageSearchHit {
  pageId: number
  title: string
  projectId: number | null
  projectName: string | null
  projectSlug: string
  relPath: string
  ancestors: { pageId: number; title: string }[]
  matchCount: number
  sources: { page: number; entries: number }
  matches: PageSearchMatch[]
}

export interface ConfluenceRef {
  kind: 'space' | 'page'
  url: string
  spaceKey: string | null
  pageId: string | null
  title: string | null
}

export interface SpaceAtlassian {
  site: string | null
  confluence: ConfluenceRef | null
  sync: { pull: boolean; push: boolean; lastSyncAt: string | null }
}

export type SiteStatus = 'ok' | 'auth_failed' | 'unreachable' | 'unknown'

export interface AtlassianSite {
  site: string
  email: string
  tokenStored: boolean
  jira: boolean
  confluence: boolean
  projects: string[]
  status: SiteStatus
}

export interface SyncItem {
  pageId?: number | null
  confluenceId?: string | null
  title: string
  reason?: string | null
}

export interface SyncResult {
  project: string
  pulled: SyncItem[]
  pushed: SyncItem[]
  created: SyncItem[]
  conflicts: SyncItem[]
  skipped: SyncItem[]
}

export interface SyncMapping {
  pageId: number
  title: string
  confluenceId: string
  confluenceTitle: string
  state: 'synced' | 'conflict'
  direction: string
}

export interface AtlassianSettings {
  site?: string | null
  confluence?: string | null
  pull?: boolean | null
  push?: boolean | null
}

export interface PageNode {
  pageId: number
  parentId: number | null
  projectId: number | null
  projectName: string | null
  projectSlug: string
  slug: string
  title: string
  relPath: string
  depth: number
  position: number
  status: string
  entryCount: number
  durationSeconds: number
  durationHuman: string
  issues: PageIssue[]
  sectionCount: number
  headingCount: number
  byteSize: number
  recordedAt: string
  childCount: number
  meetings?: PageMeeting[]
  children?: PageNode[]
}

export interface Space {
  projectId: number | null
  projectName: string | null
  projectSlug: string
  active: boolean
  entryCount: number
  pageCount: number
  pages: PageNode[]
  atlassian?: SpaceAtlassian | null
}

export interface PageEntryRow {
  entryId: number
  title: string
  summary: string
  localDay: string
  startLocal: string
  durationSeconds: number
  durationHuman: string
  running: boolean
  registered?: boolean
  issueKey?: string | null
}

export interface PageDoc {
  path: string
  relPath: string
  markdown: string | null
  frontMatter: Record<string, string>
  frontMatterValid: boolean
  preamble: string
  outline: DocHeading[]
  file: DocFile
}

export interface PageCrumb {
  pageId: number
  title: string
  slug: string
}

export interface PageChild extends PageCrumb {
  relPath: string
}

export type RefKind = 'confluence' | 'jira' | 'drive' | 'link'

export interface PageRef {
  url: string
  title: string
  kind: RefKind
  source: 'manual' | 'hook'
  firstSeenAt: string
  lastSeenAt: string
}

export type BacklogKind = 'pending' | 'finding'
export type BacklogStatus = 'open' | 'resolved'

export interface PageBacklogItem {
  id: number
  key?: string
  kind: BacklogKind
  status: BacklogStatus
  title: string
  body: string
  resolution: string
  createdAt: string
  resolvedAt: string | null
}

export interface BacklogItem extends PageBacklogItem {
  projectId: number | null
  projectKey?: string | null
  projectName: string | null
  pageId: number | null
  pageTitle: string | null
  entryId: number | null
  source: 'manual' | 'extracted'
  updatedAt: string
}

export interface BacklogMeta {
  counts: { pending: number; finding: number; resolved: number }
}

export interface PageDocument extends Omit<PageNode, 'children'> {
  ancestors: PageCrumb[]
  children: PageChild[]
  doc: PageDoc
  entries: PageEntryRow[]
  worklogIssues: string[]
  refs?: PageRef[]
  backlog?: PageBacklogItem[]
}

export interface CliPayload<D, M> {
  data: D
  meta: M
}

export function notesTree(): Promise<CliPayload<{ projects: TreeProject[]; spaces?: Space[] }, TreeMeta>> {
  return invoke('notes_tree')
}

export function pageDocument(pageId: number): Promise<CliPayload<PageDocument, TreeMeta>> {
  return invoke('page_document', { pageId })
}

export function notesDocument(entryId: number): Promise<CliPayload<NoteDocument, TreeMeta>> {
  return invoke('notes_document', { entryId })
}

export function backlogList(): Promise<CliPayload<BacklogItem[], BacklogMeta>> {
  return invoke('backlog_list')
}

export function backlogSetStatus(
  id: number,
  status: BacklogStatus,
  resolution: string | null = null,
): Promise<CliPayload<BacklogItem, unknown>> {
  return invoke('backlog_set_status', { id, status, resolution })
}

export function backlogSetKind(id: number, kind: BacklogKind): Promise<CliPayload<BacklogItem, unknown>> {
  return invoke('backlog_set_kind', { id, kind })
}

export function notesSearchPages(
  query: string,
  project: string | null,
): Promise<CliPayload<PageSearchHit[], unknown>> {
  return invoke('notes_search_pages', { query, project })
}

export function backlogAdd(
  kind: BacklogKind,
  title: string,
  body: string | null,
  pageId: number | null,
  project: string | null,
): Promise<CliPayload<BacklogItem, unknown>> {
  return invoke('backlog_add', { kind, title, body, pageId, project })
}

export function recapList(): Promise<MeetingRecord[]> {
  return invoke<MeetingRecord[]>('recap_list')
}

export function searchTranscripts(query: string, entryIds: number[]): Promise<TranscriptHit[]> {
  return invoke<TranscriptHit[]>('search_transcripts', { query, entryIds })
}

export function meetingCompress(id: string, preset: CompressPreset, prune: boolean): Promise<void> {
  return invoke<void>('meeting_compress', { id, preset, prune })
}

export function meetingStripVideo(id: string, prune: boolean): Promise<MeetingRecord> {
  return invoke<MeetingRecord>('meeting_strip_video', { id, prune })
}

export function meetingPrune(id: string): Promise<MeetingRecord> {
  return invoke<MeetingRecord>('meeting_prune', { id })
}

export function meetingDelete(id: string): Promise<MeetingDeleted> {
  return invoke<MeetingDeleted>('meeting_delete', { id })
}

export function storageReport(): Promise<StorageReport> {
  return invoke<StorageReport>('storage_report')
}

export function exportPdf(fileName: string): Promise<string> {
  return invoke<string>('export_pdf', { fileName })
}

export type ReportExportFormat = 'csv' | 'md' | 'xlsx'

export interface ReportExportInclude {
  charts?: boolean
  projects?: boolean
  entries?: boolean
  jira?: boolean
  pay?: boolean
}

export type ReportGroupBy = 'project' | 'day' | 'week'

export function exportReport(
  format: ReportExportFormat,
  report: unknown,
  include: ReportExportInclude = {},
  groupBy: ReportGroupBy = 'project',
  fileName?: string,
): Promise<string> {
  return invoke<string>('export_report', { format, report, include, groupBy, fileName: fileName ?? null })
}

export function atlassianSites(check: boolean): Promise<AtlassianSite[]> {
  return invoke<AtlassianSite[]>('atlassian_sites', { check })
}

export function atlassianSiteAdd(site: string, email: string, token: string): Promise<AtlassianSite | null> {
  return invoke<AtlassianSite | null>('atlassian_site_add', { site, email, token })
}

export function atlassianSiteTest(site: string): Promise<AtlassianSite | null> {
  return invoke<AtlassianSite | null>('atlassian_site_test', { site })
}

export function atlassianSiteRemove(site: string): Promise<void> {
  return invoke<void>('atlassian_site_remove', { site })
}

export function projectAtlassian(project: string, settings: AtlassianSettings): Promise<SpaceAtlassian | null> {
  return invoke<SpaceAtlassian | null>('project_atlassian', { project, settings })
}

export function confluenceSync(project: string | null): Promise<SyncResult[]> {
  return invoke<SyncResult[]>('confluence_sync', { project })
}

export function confluenceSyncStatus(project: string): Promise<SyncMapping[]> {
  return invoke<SyncMapping[]>('confluence_sync_status', { project })
}

export function confluenceResolve(pageId: number, keep: 'local' | 'remote'): Promise<void> {
  return invoke<void>('confluence_resolve', { pageId, keep })
}

export function onMeetingMediaChanged(handler: (change: MeetingMediaChange) => void): void {
  void listen<MeetingMediaChange>(MEETING_MEDIA_EVENT, (event) => {
    handler(event.payload)
  })
}

export function onSyncFinished(handler: () => void): void {
  void listen(SYNC_FINISHED_EVENT, () => {
    handler()
  })
}

export function meetingForEntry(entryId: number): Promise<MeetingView | null> {
  return invoke<MeetingView | null>('meeting_for_entry', { entryId })
}

export interface TranscriptParagraph {
  startMs: number
  channel: string
  speaker: string | null
  text: string
}

export interface MeetingTranscript {
  segments: MeetingSegment[]
  paragraphs: TranscriptParagraph[]
  channels: unknown
}

export interface MeetingActionItem {
  text: string
  backlogKey: string | null
}

export interface MeetingSummary {
  markdown: string
  agreements: string[]
  actionItems: MeetingActionItem[]
}

export function meetingById(id: string): Promise<MeetingView | null> {
  return invoke<MeetingView | null>('meeting_by_id', { id })
}

export function meetingTranscript(id: string): Promise<MeetingTranscript> {
  return invoke<MeetingTranscript>('meeting_transcript', { id })
}

export function meetingSummary(id: string): Promise<MeetingSummary> {
  return invoke<MeetingSummary>('meeting_summary', { id })
}

export function meetingDownload(id: string, title: string): Promise<string> {
  return invoke<string>('meeting_download', { id, title })
}

export function openMeetingFolder(dir: string): Promise<void> {
  return invoke<void>('open_meeting_folder', { dir })
}

export function mediaSrc(path: string): string {
  return convertFileSrc(path)
}

export function pageAsset(relPath: string): Promise<string | null> {
  return invoke<string | null>('page_asset', { relPath })
}

export function openDocument(relPath: string): Promise<void> {
  return invoke<void>('open_document', { relPath })
}

export function openExternal(url: string): Promise<void> {
  return invoke<void>('open_external', { url })
}

export function copyText(text: string): Promise<void> {
  return invoke<void>('copy_text', { text })
}

export function onDocsChanged(handler: () => void): void {
  void listen(DOCS_CHANGED_EVENT, () => {
    handler()
  })
}

export function quit(): Promise<void> {
  return invoke<void>('quit')
}

export type Unsubscribe = () => void

function subscribe<T>(name: string, handler: (payload: T) => void): Unsubscribe {
  let stop: (() => void) | null = null
  let cancelled = false
  void listen<T>(name, (event) => {
    if (!cancelled) handler(event.payload)
  })
    .then((unlisten) => {
      if (cancelled) unlisten()
      else stop = unlisten
    })
    .catch(() => undefined)
  return () => {
    cancelled = true
    stop?.()
    stop = null
  }
}

export function onSnapshot(handler: (value: Snapshot) => void): Unsubscribe {
  return subscribe<Snapshot>(SNAPSHOT_EVENT, handler)
}

export function liveState(): Promise<LiveView> {
  return invoke<LiveView>('live_state')
}

export function liveShow(): Promise<void> {
  return invoke('live_show')
}

export function liveHide(): Promise<void> {
  return invoke('live_hide')
}

export function liveAsk(question: string | null): Promise<number> {
  return invoke<number>('live_ask', { question })
}

export function liveSources(project: string): Promise<LiveSources | null> {
  return invoke<LiveSources | null>('live_sources', { project })
}

export function recapConfig(): Promise<LiveConfig | null> {
  return invoke<LiveConfig | null>('recap_config')
}

export function recapConfigSet(key: string, value: boolean | number | string | null): Promise<LiveConfig | null> {
  return invoke<LiveConfig | null>('recap_config_set', { key, value })
}

export function liveShortcutSet(accelerator: string): Promise<string> {
  return invoke<string>('live_shortcut_set', { accelerator })
}

export function liveTranscriptFull(): Promise<LiveFullTranscript | null> {
  return invoke<LiveFullTranscript | null>('live_transcript_full')
}

export function liveOpenMeetings(): Promise<void> {
  return invoke('live_open_meetings')
}

export function navigate(route: string): Promise<void> {
  return invoke('navigate_to', { route })
}

export function onNavigate(handler: (route: string) => void): Unsubscribe {
  return subscribe<string>(NAVIGATE_EVENT, handler)
}

export function openSourceFile(path: string): Promise<void> {
  return invoke('open_source_file', { path })
}

export function docsBranchDiff(branch: string, sha: string): Promise<BranchDiff> {
  return invoke<BranchDiff>('docs_branch_diff', { branch, sha })
}

export function pageHistory(pageId: number): Promise<PageHistory> {
  return invoke<PageHistory>('page_history', { pageId })
}

export function pageDiff(pageId: number, rev: string): Promise<PageDiff> {
  return invoke<PageDiff>('page_diff', { pageId, rev })
}

export function pageRestore(pageId: number, sha: string): Promise<unknown> {
  return invoke('page_restore', { pageId, sha })
}

export function proposalAccept(meetingId: string, n: number, markdown: string | null): Promise<Proposal> {
  return invoke<Proposal>('proposal_accept', { meetingId, n, markdown })
}

export function proposalShow(meetingId: string, n: number): Promise<ProposalDetail> {
  return invoke<ProposalDetail>('proposal_show', { meetingId, n })
}

export function proposalReject(meetingId: string, n: number): Promise<Proposal> {
  return invoke<Proposal>('proposal_reject', { meetingId, n })
}

export function pendingProposals(): Promise<PendingMeeting[]> {
  return invoke<PendingMeeting[]>('pending_proposals')
}

export function onLiveAnswer(handler: (event: LiveAnswerEvent) => void): void {
  void listen<LiveAnswerEvent>(LIVE_ANSWER_EVENT, (event) => {
    handler(event.payload)
  })
}

export function onWindowClosed(handler: () => void): Unsubscribe {
  let stop: (() => void) | null = null
  let cancelled = false
  void getCurrentWindow()
    .listen(CLOSE_REQUESTED_EVENT, () => {
      if (!cancelled) handler()
    })
    .then((unlisten) => {
      if (cancelled) unlisten()
      else stop = unlisten
    })
    .catch(() => undefined)
  return () => {
    cancelled = true
    stop?.()
    stop = null
  }
}

export function onLiveState(handler: () => void): void {
  void listen(LIVE_STATE_EVENT, () => {
    handler()
  })
}

export function onLiveTranscript(handler: (update: LiveTranscriptUpdate) => void): void {
  void listen<LiveTranscriptUpdate>(LIVE_TRANSCRIPT_EVENT, (event) => {
    handler(event.payload)
  })
}

export function describeProblem(error: unknown): Problem {
  if (
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    const problem = error as Partial<Problem> & { message: string }
    return {
      kind: problem.kind ?? 'cli-failed',
      message: problem.message,
      hint: problem.hint ?? null,
    }
  }
  return { kind: 'cli-failed', message: String(error), hint: null }
}
