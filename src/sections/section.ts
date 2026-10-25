import type { LiveTranscriptUpdate, PendingMeeting, Snapshot, ToolsStatus } from '../bita.ts'

export type ShellEvent =
  | { type: 'snapshot'; snapshot: Snapshot }
  | { type: 'tools'; tools: ToolsStatus }
  | { type: 'proposals'; proposals: PendingMeeting[] }
  | { type: 'docs-changed' }
  | { type: 'live-state' }
  | { type: 'live-transcript'; update: LiveTranscriptUpdate }
  | { type: 'visible' }

export interface SectionModule {
  mount(host: HTMLElement, path: readonly string[]): void | Promise<void>
  update(path: readonly string[]): void
  unmount(): void
  receive?(event: ShellEvent): void
  keepAlive?: boolean
}
