export type LaunchKind = 'work' | 'meeting'

export const LAUNCH_KINDS: readonly { kind: LaunchKind; label: string }[] = [
  { kind: 'work', label: 'Trabajo' },
  { kind: 'meeting', label: 'Reunión' },
]

// TODO(meeting): start meetings as 'meeting' once bita, recap, inkwell and tally accept it
const MEETING_TIMER_KIND = 'remote-meeting'

export function timerKindFor(kind: LaunchKind): string | null {
  return kind === 'meeting' ? MEETING_TIMER_KIND : null
}
