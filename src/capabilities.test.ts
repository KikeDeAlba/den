import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

function graph(entry: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entry)) return seen
  seen.add(entry)
  const text = read(entry)
  const pattern = /(?:import|export)[^'"]*?from\s+['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|import\s+['"](\.[^'"]+\.ts)['"]/g
  for (const match of text.matchAll(pattern)) {
    const relative = match[1] ?? match[2] ?? match[3]
    if (relative === undefined || !relative.endsWith('.ts')) continue
    const next = normalize(join(dirname(entry), relative))
    if (existsSync(next)) graph(next, seen)
  }
  return seen
}

function bitaFunctions(): Map<string, string> {
  const text = read(join(SRC, 'bita.ts'))
  const starts = [...text.matchAll(/export (?:async )?function (\w+)/g)]
  const bodies = new Map<string, string>()
  starts.forEach((match, index) => {
    const end = starts[index + 1]?.index ?? text.length
    bodies.set(match[1] as string, text.slice(match.index, end))
  })
  return bodies
}

const INVOKE = /invoke(?:<.*?>)?\(\s*'([a-z_0-9]+)'/g

function commandsOf(name: string, bodies: Map<string, string>, stack: string[] = []): Set<string> {
  const body = bodies.get(name) ?? ''
  const found = new Set([...body.matchAll(INVOKE)].map((match) => match[1] as string))
  for (const other of bodies.keys()) {
    if (other === name || stack.includes(other)) continue
    if (new RegExp(`\\b${other}\\(`).test(body)) for (const command of commandsOf(other, bodies, [...stack, name])) found.add(command)
  }
  return found
}

function frontendCommands(entry: string): Set<string> {
  const bodies = bitaFunctions()
  const commands = new Set<string>()
  for (const file of graph(join(SRC, entry))) {
    if (file.endsWith('bita.ts')) continue
    const text = read(file)
    for (const match of text.matchAll(INVOKE)) commands.add(match[1] as string)
    for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*bita\.ts['"]/g)) {
      for (const part of (match[1] as string).split(',')) {
        const name = part.replace('type ', '').split(' as ')[0]?.trim() ?? ''
        if (bodies.has(name)) for (const command of commandsOf(name, bodies)) commands.add(command)
      }
    }
  }
  return commands
}

function granted(capability: string): Set<string> {
  const parsed = JSON.parse(read(join(ROOT, 'src-tauri', 'capabilities', `${capability}.json`))) as { permissions: string[] }
  return new Set(
    parsed.permissions.filter((permission) => permission.startsWith('allow-')).map((permission) => permission.slice(6).replaceAll('-', '_')),
  )
}

describe('window capabilities', () => {
  it.each([
    ['main', 'shell/main.ts'],
    ['live', 'live.ts'],
  ])('%s may call every command its frontend invokes', (capability, entry) => {
    const missing = [...frontendCommands(entry)].filter((command) => !granted(capability).has(command))
    expect(missing).toEqual([])
  })

  it('keeps the assistant window away from the main window commands', () => {
    expect(frontendCommands('live.ts').has('live_state')).toBe(true)
    expect(frontendCommands('shell/main.ts').size).toBeGreaterThan(50)
    const live = granted('live')
    expect(live.has('export_pdf')).toBe(false)
    expect(live.has('meeting_download')).toBe(false)
    expect(live.size).toBeLessThan(20)
  })
})
