import '../../notes/notes.css'
import {
  confluenceSyncStatus,
  copyText,
  describeProblem,
  jiraKeyMap,
  jiraProjects,
  meetingForEntry,
  notesDocument,
  notesSearchPages,
  notesTree,
  openDocument,
  openExternal,
  openMeetingFolder,
  pageDocument,
  projects,
  recapList,
  searchTranscripts,
  toolsStatus,
  type MeetingRecord,
  type Modules,
  type PageDocument,
  type PageNode,
  type Problem,
  type Space,
} from '../../bita.ts'
import { element } from '../../dom.ts'
import { renderAside, type AsideState } from '../../notes/aside.ts'
import { renderAtlassian } from '../../notes/atlassian.ts'
import { openExportDialog } from '../../notes/export.ts'
import { openHistoryDialog } from '../../notes/history.ts'
import { isCompressing, mediaChanged, onMediaJobs, openCompressDialog, openStripDialog } from '../../notes/media-dialogs.ts'
import {
  currentFrameSrc,
  hasVideo,
  latestMeeting,
  releaseMedia,
  seekTo,
  stopPlayback,
  type MeetingContext,
  type MeetingLoad,
  type MeetingTab,
} from '../../notes/meeting.ts'
import { initProse, stepProse } from '../../notes/prose.ts'
import { pageKey, renderRail, type RailState, type Selection } from '../../notes/rail.ts'
import { renderReader, type ReaderState } from '../../notes/reader.ts'
import { attachSash } from '../../notes/sash.ts'
import { fromPageHit, withTranscripts, type PageResult, type SearchScope } from '../../notes/search.ts'
import { renderSpaceSettings } from '../../notes/space-settings.ts'
import { renderStorage, spaceStorageTotal } from '../../notes/storage.ts'
import { closeSwitcher, isSwitcherOpen, toggleSwitcher, withPages } from '../../notes/switcher.ts'
import { formatRoute, go, parseRoute } from '../../shell/routes.ts'
import { isSpaceShortcut, onSpaceChange, rememberedSpace, rememberSpace } from '../../shell/space.ts'
import type { ShellEvent } from '../section.ts'
import { docsRoute, parseDocsPath, pendientesRoute, type DocsTarget, type DocsView } from '../../shell/links.ts'
import './docs.css'

const RAIL_KEY = 'bita.notes.rail'
const ASIDE_KEY = 'bita.notes.aside'
const SCALE_KEY = 'bita.notes.scale'
const SCOPE_KEY = 'bita.notes.search-scope'
const SCALE_MIN = 0.8
const SCALE_MAX = 2
const SCALE_STEP = 0.1
const MEETING_TABS = ['document', 'minutes', 'meeting', 'proposals', 'answers'] as const

interface Dom {
  host: HTMLElement
  root: HTMLElement
  rail: HTMLElement
  reader: HTMLElement
  aside: HTMLElement
}

let dom: Dom | null = null
let alive = false
let listening = false

let spaces: Space[] = []
let expanded = new Set<string>()
let selected: Selection = null
let opened: PageDocument | null = null
let query = ''
let scope: SearchScope = rememberedScope()
let results: PageResult[] | null = null
let hit = 0
let hitCount = 0
let hitLabels: string[] = []
let active: string | null = null
let failure: Problem | null = null
let loadingTree = true
let loadingDoc = false
let railOpen = remembered(RAIL_KEY)
let asideOpen = remembered(ASIDE_KEY)
const NARROW_MAX_PX = 1100
let narrow = false
let asidePeek = false
let stopNarrowWatch: (() => void) | null = null
let stopSashes: Array<() => void> = []
let logOpen = true
let scale = rememberedScale()
let meetingTab: MeetingTab = 'document'
let meetingLoad: MeetingLoad | null = null
let meetingPageId: number | null = null
let meetingToken = 0
let activeSpace: string | null = rememberedSpace()
let clients = new Map<number, string>()
let jiraKeys = new Map<number, string>()
let records: MeetingRecord[] | null = null
let storageBytes: number | null = null
let modules: Modules | null = null
let pendingTarget: DocsTarget | null = null
let treeLoaded = false
let confluenceLinks = new Map<string, Map<number, string>>()

let railPainted = ''
let readerPainted = ''
let asidePainted = ''
let searchToken = 0
let spy: IntersectionObserver | null = null
let stopSpaceWatch: (() => void) | null = null

function can(module: keyof Modules): boolean {
  return modules === null || modules[module]
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch {
    return null
  }
}

function writeStored(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    return
  }
}

function remembered(key: string): boolean {
  return readStored(key) !== 'closed'
}

function rememberedScope(): SearchScope {
  return readStored(SCOPE_KEY) === 'all' ? 'all' : 'space'
}

function rememberedScale(): number {
  const stored = Number(readStored(SCALE_KEY))
  if (!Number.isFinite(stored) || stored <= 0) return 1
  return Math.min(SCALE_MAX, Math.max(SCALE_MIN, stored))
}

function applyScale(next: number): void {
  scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, Math.round(next * 100) / 100))
  dom?.root.style.setProperty('--doc-scale', String(scale))
  writeStored(SCALE_KEY, String(scale))
}

function visible(): boolean {
  return dom !== null && !dom.host.hidden
}

function currentSpace(): Space | null {
  return spaces.find((space) => space.projectSlug === activeSpace) ?? null
}

function walk(list: readonly PageNode[], into: PageNode[] = []): PageNode[] {
  for (const page of list) {
    into.push(page)
    walk(page.children ?? [], into)
  }
  return into
}

function allPages(): PageNode[] {
  return spaces.flatMap((space) => walk(space.pages))
}

function spacePages(space: Space | null): PageNode[] {
  return walk(space?.pages ?? [])
}

function spaceOfPage(pageId: number): Space | null {
  return spaces.find((space) => spacePages(space).some((page) => page.pageId === pageId)) ?? null
}

function crumbOf(page: PageNode): string {
  const byId = new Map(allPages().map((node) => [node.pageId, node]))
  const trail: string[] = []
  let cursor = page.parentId === null ? undefined : byId.get(page.parentId)
  while (cursor !== undefined) {
    trail.unshift(cursor.title)
    cursor = cursor.parentId === null ? undefined : byId.get(cursor.parentId)
  }
  return trail.length === 0 ? 'Raíz del espacio' : trail.join(' / ')
}

function flatOrder(): number[] {
  const order: number[] = []
  const visit = (list: PageNode[]): void => {
    for (const page of list) {
      order.push(page.pageId)
      if (expanded.has(pageKey(page))) visit(page.children ?? [])
    }
  }
  visit(currentSpace()?.pages ?? [])
  return order
}

function currentTarget(): DocsTarget {
  const space = activeSpace
  if (selected?.kind === 'page') return { kind: 'page', space: spaceOfPage(selected.id)?.projectSlug ?? space, pageId: selected.id }
  if (selected?.kind === 'storage' || selected?.kind === 'space-settings' || selected?.kind === 'atlassian') {
    return { kind: 'view', space, view: selected.kind }
  }
  return { kind: 'space', space }
}

function reflectRoute(): void {
  if (!visible()) return
  const parsed = parseRoute(docsRoute(currentTarget()))
  if (parsed === null) return
  const next = formatRoute(parsed)
  if (location.hash !== next) history.replaceState(null, '', next)
}

function confluenceUrl(page: PageDocument | null): string | null {
  if (page === null) return null
  const ref = (page.refs ?? []).find((candidate) => candidate.kind === 'confluence')
  if (ref !== undefined) return ref.url
  return confluenceLinks.get(page.projectSlug)?.get(page.pageId) ?? null
}

function confluenceBase(space: Space): string | null {
  const url = space.atlassian?.confluence?.url
  if (url === undefined || url === null) return null
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

async function loadConfluenceLinks(space: Space | null): Promise<void> {
  if (space === null || !can('confluenceSync') || confluenceLinks.has(space.projectSlug)) return
  const base = confluenceBase(space)
  if (base === null) return
  confluenceLinks.set(space.projectSlug, new Map())
  try {
    const mappings = await confluenceSyncStatus(space.projectSlug)
    const links = new Map(
      mappings.map((mapping) => [mapping.pageId, `${base}/wiki/pages/viewpage.action?pageId=${encodeURIComponent(mapping.confluenceId)}`]),
    )
    confluenceLinks.set(space.projectSlug, links)
    paint()
  } catch {
    return
  }
}

function railState(): RailState {
  const space = currentSpace()
  return {
    spaces,
    active: space,
    client: space?.projectId == null ? null : (clients.get(space.projectId) ?? null),
    expanded,
    selected,
    query,
    scope,
    results,
    loading: loadingTree,
    open: railOpen,
    backlogOpen: null,
    meetingCount: 0,
    storageBytes,
    showBacklog: false,
    showMeetings: false,
  }
}

function readerState(): ReaderState {
  const order = flatOrder()
  const at = selected?.kind === 'page' ? order.indexOf(selected.id) : -1
  return {
    page: opened,
    query,
    hit,
    hitCount,
    failure,
    loading: loadingDoc,
    canPrev: at > 0,
    canNext: at !== -1 && at < order.length - 1,
    railOpen,
    asideOpen: asideShown(),
    meeting: meetingContext(),
    video: videoActions(),
    history: can('history'),
    confluenceUrl: confluenceUrl(opened),
  }
}

function readyView(): MeetingRecord | null {
  if (meetingLoad?.state !== 'ready') return null
  const view = meetingLoad.view
  return (records ?? []).find((record) => record.id === view.id) ?? null
}

function videoActions(): ReaderState['video'] {
  if (meetingLoad?.state !== 'ready' || !hasVideo(meetingLoad.view)) return null
  return { compressing: isCompressing(meetingLoad.view.id) }
}

function meetingContext(): MeetingContext | null {
  if (opened === null || meetingLoad === null) return null
  const info = latestMeeting(opened.meetings)
  if (info === null) return null
  return { info, tab: meetingTab, load: meetingLoad }
}

function asideState(): AsideState {
  return {
    page: opened,
    active,
    open: asideShown(),
    logOpen,
    onToggleLog: toggleLog,
    meeting: meetingContext(),
    query: selected?.kind === 'page' ? query : '',
    hits: hitLabels,
    hit,
    atlassian: currentSpace()?.atlassian ?? null,
    custom: null,
  }
}

function meetingSignature(): string {
  if (meetingLoad === null) return 'none'
  const view = meetingLoad.state === 'ready' ? `${meetingLoad.view.id}:${meetingLoad.view.recording ?? ''}` : ''
  const busy = meetingLoad.state === 'ready' ? isCompressing(meetingLoad.view.id) : false
  const changes =
    meetingLoad.state === 'ready'
      ? `${(meetingLoad.view.proposals ?? []).map((proposal) => `${proposal.n}${proposal.status}`).join(',')}/${(meetingLoad.view.answers ?? []).length}`
      : ''
  return `${meetingTab}:${meetingLoad.state}:${view}:${busy}:${changes}`
}

function spacesSignature(): string {
  return spaces
    .map((space) => {
      const sync = space.atlassian?.sync
      return `${space.projectSlug}:${space.pageCount}:${sync?.pull ?? ''}:${sync?.push ?? ''}:${sync?.lastSyncAt ?? ''}`
    })
    .join(',')
}

function railSignature(): string {
  return [
    JSON.stringify(modules),
    spacesSignature(),
    activeSpace ?? '',
    currentSpace()?.pages.length ?? 0,
    clients.size,
    [...expanded].sort().join('|'),
    selected === null ? 'none' : `${selected.kind}:${selected.id}`,
    query,
    scope,
    results === null ? 'pending' : results.map((result) => `${result.pageId}:${result.matchCount}`).join('.'),
    loadingTree,
    railOpen,
    storageBytes ?? '',
  ].join('~')
}

function readerSignature(): string {
  return [
    JSON.stringify(modules),
    selected === null ? 'none' : `${selected.kind}:${selected.id}`,
    opened?.doc.relPath ?? 'none',
    opened?.doc.file.status ?? 'none',
    opened?.recordedAt ?? '',
    confluenceUrl(opened) ?? '',
    query,
    hit,
    hitCount,
    failure?.message ?? '',
    loadingDoc,
    railOpen,
    asideShown(),
    meetingSignature(),
  ].join('~')
}

function asideSignature(): string {
  return [
    selected?.kind ?? 'none',
    opened?.pageId ?? 'none',
    opened?.recordedAt ?? '',
    opened?.entries.length ?? 0,
    opened?.issues.map((issue) => `${issue.issueKey}:${issue.statusCategory}`).join(',') ?? '',
    opened?.refs?.map((ref) => ref.url).join(',') ?? '',
    opened?.backlog?.map((item) => `${item.id}:${item.status}`).join(',') ?? '',
    active ?? '',
    asideShown(),
    logOpen,
    meetingLoad?.state ?? 'none',
    query,
    hit,
    hitLabels.join('|'),
    spacesSignature(),
    activeSpace ?? '',
  ].join('~')
}

function viewSignature(kind: DocsView): string {
  return [kind, spacesSignature(), activeSpace ?? '', railOpen, clients.size, jiraKeys.size, JSON.stringify(modules)].join('~')
}

function paint(): void {
  if (dom === null) return
  const { root, rail, reader, aside } = dom
  const kind = selected?.kind ?? null
  root.classList.toggle('notas--wide', kind === 'storage' || kind === 'space-settings' || kind === 'atlassian')

  const railNow = railSignature()
  if (railNow !== railPainted) {
    railPainted = railNow
    renderRail(rail, railState(), {
      onQuery: runQuery,
      onScope: setScope,
      onToggle: toggleNode,
      onSelectPage: (pageId) => selectPage(pageId),
      onSelectResult: selectResult,
      onSelectBacklog: () => go(pendientesRoute(activeSpace)),
      onSelectMeetings: () => go('reuniones'),
      onSelectStorage: () => selectView('storage'),
      onSelectSettings: () => selectView('space-settings'),
      onSwitcher: showSwitcher,
      onSpace: (slug) => {
        switchSpace(slug)
        setRail(true)
      },
      onCollapse: () => setRail(false),
      onExpand: () => setRail(true),
    })
  }

  if (kind === 'storage' || kind === 'space-settings' || kind === 'atlassian') {
    const view = viewSignature(kind)
    if (view !== readerPainted) {
      readerPainted = view
      paintView(reader, kind)
    }
  } else {
    const readerNow = readerSignature()
    if (readerNow !== readerPainted) {
      readerPainted = readerNow
      renderReader(reader, readerState(), {
        onPrev: () => step(-1),
        onNext: () => step(1),
        onCopy: copy,
        onCopyLink: copyLink,
        onOpenDocument: (relPath) => {
          void openDocument(relPath).catch(showFailure)
        },
        onOpenExternal: (url) => {
          void openExternal(url).catch(showFailure)
        },
        onHit: moveHit,
        onCrumb: selectPage,
        onExpandRail: () => setRail(true),
        onExpandAside: () => setAside(true),
        onMeetingTab: setMeetingTab,
        onSeek: seekMeeting,
        onExport: exportCurrent,
        onCompress: compressCurrent,
        onStripVideo: stripCurrent,
        onHistory: historyCurrent,
        onOpenPage: (pageId) => selectPage(pageId),
        onMeetingChanged: reloadMeeting,
      })
      afterReaderPaint()
    }
  }

  const asideNow = asideSignature()
  if (asideNow !== asidePainted) {
    asidePainted = asideNow
    renderAside(aside, asideState(), {
      onHeading: scrollToHeading,
      onIssue: (url) => {
        void openExternal(url).catch(showFailure)
      },
      onChild: selectPage,
      onEntry: openEntryDocument,
      onBacklog: () => go(pendientesRoute(opened?.projectSlug ?? activeSpace)),
      onBacklogItem: (id) => go(pendientesRoute(opened?.projectSlug ?? activeSpace, String(id))),
      onCollapse: () => setAside(false),
      onExpand: () => setAside(true),
      onOpenFolder: (dir) => {
        void openMeetingFolder(dir).catch(showFailure)
      },
      onHit: (index) => {
        moveHit(index - hit)
      },
    })
  }
}

function paintView(target: HTMLElement, kind: DocsView): void {
  const space = currentSpace()
  if (kind === 'storage') {
    renderStorage(target, {
      spaces,
      activeSpace: space,
      railOpen,
      lockSpace: true,
      onExpandRail: () => setRail(true),
      onOpenPage: (pageId) => selectPage(pageId, true),
      beforeReplace: releaseIfShowing,
    })
    return
  }
  if (kind === 'atlassian') {
    renderAtlassian(target, {
      railOpen,
      onExpandRail: () => setRail(true),
      onBack: () => selectView('space-settings'),
    })
    return
  }
  if (space === null) {
    target.replaceChildren()
    return
  }
  renderSpaceSettings(target, {
    space,
    clientName: space.projectId === null ? null : (clients.get(space.projectId) ?? null),
    jiraKey: space.projectId === null ? null : (jiraKeys.get(space.projectId) ?? null),
    railOpen,
    onExpandRail: () => setRail(true),
    onManageConnections: () => selectView('atlassian'),
    available: { atlassian: can('atlassian'), meetings: can('meetings') },
    onSaved: () => {
      void loadTree()
    },
  })
}

function releaseIfShowing(meetingId: string): void {
  if (meetingLoad?.state === 'ready' && meetingLoad.view.id === meetingId) releaseMedia()
}

function setMeetingTab(tab: MeetingTab): void {
  if (tab === meetingTab) return
  meetingTab = tab
  if (tab === 'document') stopPlayback()
  paint()
}

function seekMeeting(seconds: number): void {
  const context = meetingContext()
  if (context === null || context.load.state !== 'ready') return
  const view = context.load.view
  if (meetingTab !== 'meeting') {
    meetingTab = 'meeting'
    paint()
  }
  seekTo(view, seconds)
}

async function loadMeeting(pageId: number, entryId: number): Promise<void> {
  const token = meetingToken + 1
  meetingToken = token
  if (meetingPageId !== pageId || meetingLoad === null) meetingLoad = { state: 'loading' }
  paint()
  try {
    const view = await meetingForEntry(entryId)
    if (token !== meetingToken) return
    meetingLoad = view === null ? { state: 'missing' } : { state: 'ready', view }
  } catch (error) {
    if (token !== meetingToken) return
    meetingLoad = { state: 'failed', problem: describeProblem(error) }
  }
  paint()
}

function setRail(open: boolean): void {
  railOpen = open
  writeStored(RAIL_KEY, open ? 'open' : 'closed')
  paint()
}

function asideShown(): boolean {
  return narrow ? asidePeek : asideOpen
}

function setAside(open: boolean): void {
  if (narrow) {
    asidePeek = open
  } else {
    asideOpen = open
    writeStored(ASIDE_KEY, open ? 'open' : 'closed')
  }
  paint()
}

function watchNarrow(root: HTMLElement): () => void {
  const query = window.matchMedia(`(max-width: ${NARROW_MAX_PX}px)`)
  const apply = (): void => {
    if (narrow === query.matches) return
    narrow = query.matches
    asidePeek = false
    root.classList.toggle('docs--narrow', narrow)
    paint()
  }
  narrow = query.matches
  root.classList.toggle('docs--narrow', narrow)
  query.addEventListener('change', apply)
  return () => query.removeEventListener('change', apply)
}

function toggleLog(): void {
  logOpen = !logOpen
  paint()
}

function afterReaderPaint(): void {
  if (dom === null) return
  const marks = [...dom.reader.querySelectorAll<HTMLElement>('mark.hit')]
  const labels = marks.map(hitLabel)
  if (marks.length !== hitCount || labels.join('|') !== hitLabels.join('|')) {
    if (marks.length !== hitCount) hit = 0
    hitCount = marks.length
    hitLabels = labels
    readerPainted = readerSignature()
  }
  highlightHit(marks)
  watchSections()
}

function hitLabel(mark: HTMLElement): string {
  const tagged = mark.closest<HTMLElement>('[data-hit-label]')
  if (tagged !== null) return tagged.dataset['hitLabel'] ?? ''
  const section = mark.closest<HTMLElement>('.doc-section[data-heading]')
  if (section !== null) return section.dataset['heading'] ?? ''
  if (mark.closest('.room-row') !== null) return 'Transcripción'
  if (mark.closest('.meeting-article') !== null) return 'Minuta'
  return 'Introducción'
}

function highlightHit(marks: HTMLElement[]): void {
  marks.forEach((mark, index) => {
    mark.classList.toggle('hit--on', index === hit)
  })
  marks[hit]?.scrollIntoView({ block: 'center' })
}

function moveHit(delta: number): void {
  if (hitCount === 0 || dom === null) return
  hit = (hit + delta + hitCount) % hitCount
  highlightHit([...dom.reader.querySelectorAll<HTMLElement>('mark.hit')])
  const label = dom.reader.querySelector<HTMLElement>('.hit-count')
  if (label) label.textContent = `«${query.trim()}» ${hit + 1} de ${hitCount}`
  readerPainted = readerSignature()
  paint()
}

function scrollToHeading(anchor: string): void {
  dom?.reader.querySelector<HTMLElement>(`#${CSS.escape(anchor)}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
}

function watchSections(): void {
  spy?.disconnect()
  if (dom === null) return
  const blocks = [...dom.reader.querySelectorAll<HTMLElement>('.doc-section[data-heading]')]
  if (blocks.length === 0) {
    active = null
    return
  }
  spy = new IntersectionObserver(
    (entries) => {
      const shown = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0]
      if (!shown) return
      const anchor = (shown.target as HTMLElement).id
      if (anchor === active) return
      active = anchor
      paint()
    },
    { root: dom.reader.querySelector('.doc-body'), rootMargin: '-10% 0px -70% 0px' },
  )
  for (const block of blocks) spy.observe(block)
}

function step(delta: number): void {
  const order = flatOrder()
  if (order.length === 0) return
  const at = selected?.kind === 'page' ? order.indexOf(selected.id) : -1
  const next = order[at === -1 ? 0 : Math.min(order.length - 1, Math.max(0, at + delta))]
  if (next !== undefined && next !== selected?.id) selectPage(next)
}

function leavePage(): void {
  stopPlayback()
  opened = null
  active = null
  failure = null
}

function selectView(view: DocsView): void {
  if (view === 'atlassian' && !can('atlassian')) return
  selected = { kind: view, id: 0 }
  leavePage()
  paint()
  reflectRoute()
}

function refreshStorage(): void {
  const slug = activeSpace
  if (slug === null) {
    storageBytes = null
    paint()
    return
  }
  void spaceStorageTotal(spaces, slug)
    .then((bytes) => {
      if (slug !== activeSpace) return
      storageBytes = bytes
      paint()
    })
    .catch(() => undefined)
}

function switchSpace(slug: string, keepSelection = false): void {
  const space = spaces.find((candidate) => candidate.projectSlug === slug)
  if (space === undefined) return
  const changed = slug !== activeSpace
  activeSpace = slug
  rememberSpace(slug)
  if (!changed || keepSelection) {
    paint()
    return
  }
  storageBytes = null
  refreshStorage()
  void loadConfluenceLinks(space)
  if (query.trim().length > 0 && scope === 'space') runQuery(query)
  if (selected?.kind === 'page' || selected === null) {
    selected = null
    leavePage()
  }
  readerPainted = ''
  paint()
  reflectRoute()
}

function showSwitcher(anchor: HTMLElement): void {
  toggleSwitcher({ anchor, spaces, active: activeSpace, onPick: (slug) => switchSpace(slug) })
}

function setScope(next: SearchScope): void {
  if (next === scope) return
  scope = next
  writeStored(SCOPE_KEY, next)
  runQuery(query)
}

function selectPage(pageId: number, keepTab = false): void {
  const owner = spaceOfPage(pageId)
  if (owner !== null && owner.projectSlug !== activeSpace) switchSpace(owner.projectSlug, true)
  if (!keepTab && meetingPageId !== pageId) meetingTab = 'document'
  selected = { kind: 'page', id: pageId }
  hit = 0
  active = null
  revealAncestors(pageId)
  paint()
  reflectRoute()
  void loadPage(pageId, keepTab)
}

function selectResult(result: PageResult): void {
  const transcriptOnly = result.page === 0 && result.entries === 0 && result.transcript > 0
  selectPage(result.pageId, transcriptOnly)
  if (transcriptOnly) meetingTab = 'meeting'
}

function revealAncestors(pageId: number): void {
  const byId = new Map(allPages().map((page) => [page.pageId, page]))
  let cursor = byId.get(pageId)
  while (cursor?.parentId != null) {
    const parent = byId.get(cursor.parentId)
    if (!parent) break
    expanded.add(pageKey(parent))
    cursor = parent
  }
}

async function loadPage(pageId: number, keepTab = false): Promise<void> {
  loadingDoc = true
  failure = null
  paint()
  try {
    const payload = await pageDocument(pageId)
    if (selected?.kind !== 'page' || selected.id !== pageId) return
    opened = payload.data
    loadingDoc = false
    const info = latestMeeting(opened.meetings)
    if (meetingPageId !== pageId) {
      if (!keepTab) meetingTab = 'document'
      stopPlayback()
    }
    if (info === null) {
      meetingLoad = null
      meetingTab = 'document'
      meetingPageId = pageId
    } else if (meetingPageId !== pageId || meetingLoad?.state !== 'ready') {
      void loadMeeting(pageId, info.entryId)
      meetingPageId = pageId
    }
  } catch (error) {
    if (selected?.kind !== 'page' || selected.id !== pageId) return
    loadingDoc = false
    failure = describeProblem(error)
  }
  paint()
}

function historyCurrent(): void {
  if (opened === null) return
  const page = opened
  openHistoryDialog({ pageId: page.pageId, title: page.title, projectName: page.projectName }, () => {
    void loadPage(page.pageId, true)
  })
}

function reloadMeeting(): void {
  if (opened === null) return
  const info = latestMeeting(opened.meetings)
  if (info === null) return
  meetingPageId = opened.pageId
  void loadMeeting(opened.pageId, info.entryId)
}

function currentRecord(): Promise<MeetingRecord | null> {
  const known = readyView()
  if (known !== null) return Promise.resolve(known)
  return recapList()
    .then((list) => {
      records = list
      return readyView()
    })
    .catch((error: unknown) => {
      showFailure(error)
      return null
    })
}

function compressCurrent(): void {
  if (meetingLoad?.state !== 'ready') return
  const view = meetingLoad.view
  void currentRecord().then((record) => {
    if (record === null) return
    openCompressDialog(record, { frameSrc: currentFrameSrc(view), beforeReplace: releaseMedia })
  })
}

function stripCurrent(): void {
  if (meetingLoad?.state !== 'ready') return
  void currentRecord().then((record) => {
    if (record === null) return
    openStripDialog(record, {
      beforeReplace: releaseMedia,
      onDone: () => {
        records = null
        reloadMeeting()
        refreshStorage()
      },
    })
  })
}

function exportCurrent(): void {
  if (opened === null) return
  const pageId = opened.pageId
  const node = allPages().find((page) => page.pageId === pageId)
  const space = spaceOfPage(pageId) ?? currentSpace()
  if (node === undefined || space === null) return
  openExportDialog({
    root: node,
    space,
    client: space.projectId === null ? null : (clients.get(space.projectId) ?? null),
    onOpenDocument: (relPath) => {
      void openDocument(relPath).catch(showFailure)
    },
  })
}

function openEntryDocument(entryId: number): void {
  void (async () => {
    try {
      const payload = await notesDocument(entryId)
      const relPath = payload.data.doc?.relPath
      if (relPath === undefined) {
        failure = {
          kind: 'unreadable',
          message: 'Ese bloque no dejó un documento propio.',
          hint: 'Lo que se hizo está en el registro de la página.',
        }
        paint()
        return
      }
      await openDocument(relPath)
    } catch (error) {
      showFailure(error)
    }
  })()
}

function toggleNode(key: string): void {
  if (expanded.has(key)) expanded.delete(key)
  else expanded.add(key)
  paint()
}

function runQuery(value: string): void {
  query = value
  const token = searchToken + 1
  searchToken = token
  if (value.trim().length === 0) {
    results = null
    hitLabels = []
    paint()
    return
  }
  results = null
  paint()
  window.setTimeout(() => {
    if (searchToken !== token) return
    void search(value.trim(), token)
  }, 180)
}

async function search(value: string, token: number): Promise<void> {
  const space = scope === 'space' ? currentSpace() : null
  try {
    const payload = await notesSearchPages(value, space?.projectSlug ?? null)
    if (searchToken !== token) return
    const pages = space === null ? allPages() : spacePages(space)
    const allowed = new Set(pages.map((page) => page.pageId))
    results = payload.data.map(fromPageHit).filter((result) => space === null || allowed.has(result.pageId))
    paint()
    const entryIds = pages.flatMap((page) => (page.meetings ?? []).map((meeting) => meeting.entryId))
    if (entryIds.length === 0) return
    const transcripts = await searchTranscripts(value, entryIds).catch(() => [])
    if (searchToken !== token || results === null) return
    results = withTranscripts(results, transcripts, pages, crumbOf)
  } catch (error) {
    if (searchToken !== token) return
    results = []
    failure = describeProblem(error)
  }
  paint()
}

function copy(text: string): void {
  void copyText(text).catch(showFailure)
}

function copyLink(): void {
  if (opened === null) return
  copy(confluenceUrl(opened) ?? opened.doc.path)
}

function showFailure(error: unknown): void {
  failure = describeProblem(error)
  paint()
}

function chooseDefaultSpace(): void {
  if (spaces.some((space) => space.projectSlug === activeSpace)) return
  const first = withPages(spaces)[0] ?? spaces[0]
  activeSpace = first?.projectSlug ?? null
}

async function loadTree(): Promise<void> {
  loadingTree = true
  try {
    const payload = await notesTree()
    spaces = payload.data.spaces ?? []
    chooseDefaultSpace()
    failure = null
  } catch (error) {
    failure = describeProblem(error)
  }
  loadingTree = false
  treeLoaded = true
  paint()
  refreshStorage()
  void loadConfluenceLinks(currentSpace())
  const target = pendingTarget
  pendingTarget = null
  if (target !== null) void apply(target)
}

async function loadClients(): Promise<void> {
  try {
    const list = await projects()
    clients = new Map(list.filter((project) => project.clientName !== null).map((project) => [project.id, project.clientName as string]))
    jiraKeys = can('jira') ? jiraKeyMap(await jiraProjects().catch(() => [])) : new Map<number, string>()
    paint()
  } catch {
    return
  }
}

function focusOnMeeting(entryId: number, tab: string): void {
  const page = allPages().find((candidate) => (candidate.meetings ?? []).some((meeting) => meeting.entryId === entryId))
  if (page === undefined) return
  meetingTab = MEETING_TABS.find((name) => name === tab) ?? 'document'
  selectPage(page.pageId, true)
}

async function focusOnEntry(entryId: number): Promise<void> {
  try {
    const payload = await notesDocument(entryId)
    const relPath = payload.data.doc?.relPath
    const page = relPath === undefined ? undefined : allPages().find((candidate) => candidate.relPath === relPath)
    if (page !== undefined) {
      selectPage(page.pageId)
      return
    }
    failure = { kind: 'unreadable', message: 'Ese cronómetro todavía no tiene página.', hint: null }
    paint()
  } catch (error) {
    showFailure(error)
  }
}

async function apply(target: DocsTarget): Promise<void> {
  if (!treeLoaded) {
    pendingTarget = target
    return
  }
  switch (target.kind) {
    case 'space':
      if (target.space !== null) switchSpace(target.space)
      reflectRoute()
      return
    case 'page':
      if (selected?.kind === 'page' && selected.id === target.pageId) return
      if (allPages().some((page) => page.pageId === target.pageId)) selectPage(target.pageId)
      else if (target.space !== null) switchSpace(target.space)
      return
    case 'view':
      if (target.space !== null) switchSpace(target.space, true)
      if (selected?.kind !== target.view) selectView(target.view)
      return
    case 'entry':
      await focusOnEntry(target.entryId)
      return
    case 'meeting':
      focusOnMeeting(target.entryId, target.tab)
      return
  }
}

function keys(event: KeyboardEvent): void {
  if (!visible() || dom === null) return
  const target = event.target as HTMLElement | null
  const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA'
  const command = event.metaKey || event.ctrlKey

  if (isSpaceShortcut(event)) {
    event.preventDefault()
    if (!railOpen) setRail(true)
    const anchor = dom.rail.querySelector<HTMLElement>('#space-switch')
    if (anchor !== null) showSwitcher(anchor)
    return
  }

  if (isSwitcherOpen()) return

  if (command && event.key.toLowerCase() === 'f') {
    event.preventDefault()
    if (!railOpen) setRail(true)
    const input = dom.rail.querySelector<HTMLInputElement>('#rail-query')
    input?.focus()
    input?.select()
    return
  }

  if (command && (event.key === '=' || event.key === '+')) {
    event.preventDefault()
    applyScale(scale + SCALE_STEP)
    return
  }

  if (command && (event.key === '-' || event.key === '_')) {
    event.preventDefault()
    applyScale(scale - SCALE_STEP)
    return
  }

  if (command && event.key === '0') {
    event.preventDefault()
    applyScale(1)
    return
  }

  if (command && (event.key === ']' || event.key === '[')) {
    event.preventDefault()
    stepProse(event.key === ']' ? 1 : -1)
    return
  }

  if (command && event.key.toLowerCase() === 'g') {
    event.preventDefault()
    moveHit(event.shiftKey ? -1 : 1)
    return
  }

  if (event.key === 'Escape') {
    if (document.querySelector('.export-overlay, .mdlg-overlay') !== null) return
    if (query.trim().length > 0) {
      runQuery('')
      return
    }
    if (typing) (target as HTMLInputElement).blur()
    return
  }

  if (typing || command || selected?.kind !== 'page') return
  if (target?.closest('.room-list, .mp-track') != null) return

  if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
    event.preventDefault()
    step(-1)
    return
  }
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
    event.preventDefault()
    step(1)
  }
}

function sash(className: string, label: string): HTMLElement {
  const handle = element('div', `sash ${className}`)
  handle.setAttribute('role', 'separator')
  handle.setAttribute('aria-orientation', 'vertical')
  handle.setAttribute('aria-label', label)
  handle.tabIndex = 0
  return handle
}

function build(host: HTMLElement): Dom {
  const root = element('div', 'notes-root docs')
  const rail = element('aside', 'tree-rail')
  const reader = element('section', 'reader')
  const aside = element('aside', 'aside')
  const railSash = sash('sash--rail', 'Ancho del árbol')
  const asideSash = sash('sash--aside', 'Ancho del panel lateral')
  root.append(rail, reader, aside, railSash, asideSash)
  host.replaceChildren(root)

  stopSashes.forEach((stop) => stop())
  stopSashes = [
    attachSash({
      handle: railSash,
      root,
      variable: '--rail-open',
      side: 'left',
      storageKey: 'bita.notes.rail-width',
      initial: 240,
      min: 180,
      max: 520,
      readerMin: 420,
      otherWidth: () => aside.getBoundingClientRect().width,
    }),
    attachSash({
      handle: asideSash,
      root,
      variable: '--aside-open',
      side: 'right',
      storageKey: 'bita.notes.aside-width',
      initial: 200,
      min: 160,
      max: 440,
      readerMin: 420,
      otherWidth: () => rail.getBoundingClientRect().width,
    }),
  ]
  return { host, root, rail, reader, aside }
}

function applyModules(next: Modules): void {
  modules = next
  if (selected?.kind === 'atlassian' && !next.atlassian) {
    selected = null
    leavePage()
  }
  railPainted = ''
  readerPainted = ''
  void loadTree()
  paint()
}

function listenOnce(): void {
  if (listening) return
  listening = true
  window.addEventListener('keydown', keys)
  onMediaJobs(() => {
    if (!alive) return
    readerPainted = ''
    paint()
  })
}

export function receive(event: ShellEvent): void {
  if (event.type === 'meeting-media') mediaChanged(event.change)
  if (!alive) return
  switch (event.type) {
    case 'docs-changed':
      void loadTree()
      if (selected?.kind === 'page') void loadPage(selected.id, true)
      break
    case 'sync-finished':
      confluenceLinks = new Map()
      void loadTree()
      break
    case 'meeting-media':
      records = null
      refreshStorage()
      if (meetingLoad?.state === 'ready' && meetingLoad.view.id === event.change.id) reloadMeeting()
      else paint()
      break
    case 'tools':
      applyModules(event.tools.modules)
      break
  }
}

export async function mount(host: HTMLElement, path: readonly string[]): Promise<void> {
  dom = build(host)
  alive = true
  railPainted = ''
  readerPainted = ''
  asidePainted = ''
  applyScale(scale)
  stopNarrowWatch = watchNarrow(dom.root)
  initProse(dom.root)
  listenOnce()
  stopSpaceWatch = onSpaceChange((slug) => {
    if (slug !== activeSpace && treeLoaded) switchSpace(slug)
  })
  pendingTarget = parseDocsPath(path)
  try {
    modules = (await toolsStatus()).modules
  } catch {
    modules = null
  }
  paint()
  await loadTree()
  void loadClients()
}

export function update(path: readonly string[]): void {
  void apply(parseDocsPath(path))
}

export function unmount(): void {
  alive = false
  closeSwitcher()
  stopPlayback()
  spy?.disconnect()
  spy = null
  stopSpaceWatch?.()
  stopSpaceWatch = null
  stopNarrowWatch?.()
  stopNarrowWatch = null
  stopSashes.forEach((stop) => stop())
  stopSashes = []
  asidePeek = false
  dom = null
  treeLoaded = false
}
