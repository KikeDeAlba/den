import type { AgentInfo } from './api.ts'

export const DISMISSED_KEY = 'den.agentes.dismissed'
export const DISMISSED_LIMIT = 200

export function sessionKey(info: Pick<AgentInfo, 'id' | 'startedAt'>): string {
  return `${info.id}@${info.startedAt}`
}

export function canDismiss(info: Pick<AgentInfo, 'alive'>): boolean {
  return !info.alive
}

export function isDismissed(info: Pick<AgentInfo, 'id' | 'startedAt' | 'alive'>, dismissed: ReadonlySet<string>): boolean {
  return canDismiss(info) && dismissed.has(sessionKey(info))
}

export function readDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY)
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((item): item is string => typeof item === 'string'))
  } catch {
    return new Set()
  }
}

function write(keys: Iterable<string>): void {
  try {
    const list = [...keys].slice(-DISMISSED_LIMIT)
    if (list.length === 0) localStorage.removeItem(DISMISSED_KEY)
    else localStorage.setItem(DISMISSED_KEY, JSON.stringify(list))
  } catch {
    return
  }
}

export function rememberDismissed(info: Pick<AgentInfo, 'id' | 'startedAt'>): void {
  const keys = readDismissed()
  keys.delete(sessionKey(info))
  keys.add(sessionKey(info))
  write(keys)
}

export function pruneDismissed(present: readonly Pick<AgentInfo, 'id' | 'startedAt'>[]): void {
  const keys = readDismissed()
  const known = new Set(present.map(sessionKey))
  const kept = [...keys].filter((key) => known.has(key))
  if (kept.length !== keys.size) write(kept)
}
