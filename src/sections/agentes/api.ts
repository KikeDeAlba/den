import { Channel, invoke } from '@tauri-apps/api/core'

export type { AgentInfo, HarnessId, SessionDirectory, SessionEntry, SessionListing, SpawnRequest } from '../../bita.ts'
import type { AgentInfo, SessionDirectory, SessionListing, SpawnRequest } from '../../bita.ts'

export type OutputHandler = (bytes: Uint8Array) => void

function command(name: string): string {
  return `plugin:agents|${name}`
}

export function toBytes(message: unknown): Uint8Array {
  if (message instanceof Uint8Array) return message
  if (message instanceof ArrayBuffer) return new Uint8Array(message)
  if (Array.isArray(message)) return Uint8Array.from(message as number[])
  return new Uint8Array()
}

function channel(handler: OutputHandler): Channel<unknown> {
  return new Channel<unknown>((message) => handler(toBytes(message)))
}

export function spawnAgent(request: SpawnRequest, cols: number, rows: number, handler: OutputHandler): Promise<AgentInfo> {
  return invoke<AgentInfo>(command('agent_spawn'), { request, cols, rows, onOutput: channel(handler) })
}

export function attachAgent(id: number, handler: OutputHandler): Promise<AgentInfo> {
  return invoke<AgentInfo>(command('agent_attach'), { id, onOutput: channel(handler) })
}

export function writeAgent(id: number, data: Uint8Array): Promise<void> {
  return invoke<void>(command('agent_write'), { id, data: Array.from(data) })
}

export function sendAgent(id: number, text: string): Promise<void> {
  return invoke<void>(command('agent_send'), { id, text })
}

export function resizeAgent(id: number, cols: number, rows: number): Promise<void> {
  return invoke<void>(command('agent_resize'), { id, cols, rows })
}

export function killAgent(id: number): Promise<void> {
  return invoke<void>(command('agent_kill'), { id })
}

export function listAgents(): Promise<AgentInfo[]> {
  return invoke<AgentInfo[]>(command('agent_list'))
}

export function bitaSessions(cwd: string | null, limit = 50): Promise<SessionListing[]> {
  return invoke<SessionListing[]>(command('agent_sessions'), { cwd, limit })
}

export function bitaDirs(limit = 20): Promise<SessionDirectory[]> {
  return invoke<SessionDirectory[]>(command('agent_dirs'), { limit })
}

export function pickFolder(start: string | null): Promise<string | null> {
  return invoke<string | null>(command('agent_pick_folder'), { start })
}
