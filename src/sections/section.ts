import type { LiveAnswerEvent, LiveTranscriptUpdate, MeetingMediaChange, PendingMeeting, Snapshot, ToolsStatus } from '../bita.ts'

export type ShellEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'tools'; tools: ToolsStatus }
  | { type: 'proposals'; proposals: PendingMeeting[] }
  | { type: 'docs-changed' }
  | { type: 'sync-finished' }
  | { type: 'meeting-media'; change: MeetingMediaChange }
  | { type: 'live-state' }
  | { type: 'live-transcript'; update: LiveTranscriptUpdate }
  | { type: 'live-answer'; answer: LiveAnswerEvent }
  | { type: 'visible' }
  | { type: 'hidden' }

export interface SectionModule {
  mount(host: HTMLElement, path: readonly string[]): void | Promise<void>
  update(path: readonly string[]): void
  unmount(): void
  receive?(event: ShellEvent): void
  keepAlive?: boolean
}
