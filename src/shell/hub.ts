import {
  describeProblem,
  onAgentChanged,
  onDocsChanged,
  onLiveAnswer,
  onLiveState,
  onLiveTranscript,
  onMeetingMediaChanged,
  onSnapshot,
  onSyncFinished,
  onToolsChanged,
  onWindowClosed,
  pendingProposals,
  refresh,
  snapshot,
  toolsStatus,
  type Modules,
  type PendingMeeting,
  type Snapshot,
  type ToolsStatus,
} from '../bita.ts'
import type { ShellEvent } from '../sections/section.ts'

export interface ShellState {
  snapshot: Snapshot
  tools: ToolsStatus | null
  proposals: PendingMeeting[]
}

const state: ShellState = {
  snapshot: { running: [], todaySeconds: 0, problem: null },
  tools: null,
  proposals: [],
}

let sink: (event: ShellEvent) => void = () => {}
let proposalsTicket = 0

export function shellState(): Readonly<ShellState> {
  return state
}

export function moduleEnabled(tools: ToolsStatus | null, module: keyof Modules): boolean {
  return tools === null || tools.modules[module]
}

function emit(event: ShellEvent): void {
  if (event.type === 'snapshot') state.snapshot = event.snapshot
  if (event.type === 'tools') state.tools = event.tools
  if (event.type === 'proposals') state.proposals = event.proposals
  sink(event)
}

async function loadProposals(): Promise<void> {
  proposalsTicket += 1
  const mine = proposalsTicket
  let next: PendingMeeting[] = []
  if (moduleEnabled(state.tools, 'proposals')) {
    try {
      next = await pendingProposals()
    } catch {
      next = []
    }
  }
  if (mine === proposalsTicket) emit({ type: 'proposals', proposals: next })
}

function listenAll(): void {
  onSnapshot((value) => emit({ type: 'snapshot', snapshot: value }))
  onToolsChanged((status) => {
    emit({ type: 'tools', tools: status })
    void loadProposals()
  })
  onDocsChanged(() => {
    emit({ type: 'docs-changed' })
    void loadProposals()
  })
  onLiveState(() => {
    emit({ type: 'live-state' })
    void loadProposals()
  })
  onLiveTranscript((update) => emit({ type: 'live-transcript', update }))
  onLiveAnswer((answer) => emit({ type: 'live-answer', answer }))
  onSyncFinished(() => emit({ type: 'sync-finished' }))
  onMeetingMediaChanged((change) => emit({ type: 'meeting-media', change }))
  onAgentChanged((info) => emit({ type: 'agent', info }))
  onWindowClosed(() => emit({ type: 'hidden' }))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') {
      emit({ type: 'hidden' })
      return
    }
    emit({ type: 'visible' })
    void loadProposals()
  })
}

export function needsSetup(current: Readonly<ShellState>): boolean {
  const tools = current.tools
  const nothing = tools !== null && !tools.modules.timers && !tools.modules.notes && !tools.modules.meetings
  return nothing || (moduleEnabled(tools, 'timers') && current.snapshot.problem !== null)
}

export async function startHub(receive: (event: ShellEvent) => void): Promise<void> {
  sink = receive
  listenAll()
  try {
    emit({ type: 'snapshot', snapshot: await snapshot() })
  } catch {
    emit({ type: 'snapshot', snapshot: state.snapshot })
  }
  try {
    emit({ type: 'tools', tools: await toolsStatus() })
  } catch {
    state.tools = null
  }
  try {
    emit({ type: 'snapshot', snapshot: await refresh() })
  } catch (error) {
    emit({ type: 'snapshot', snapshot: { running: [], todaySeconds: 0, problem: describeProblem(error) } })
  }
  void loadProposals()
}
