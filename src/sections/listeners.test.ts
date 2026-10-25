import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const BITA_LISTENERS = /(?<![.\w])on(Snapshot|ToolsChanged|DocsChanged|SyncFinished|MeetingMediaChanged|LiveAnswer|LiveState|LiveTranscript|WindowClosed|Navigate)\s*\(/

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : []
  })
}

describe('sections and the modules they mount', () => {
  const root = join(import.meta.dirname, '..')
  const files = ['sections', 'notes', 'reportes', 'cerebro'].flatMap((dir) => sources(join(root, dir)))

  it.each(files)('%s leaves Tauri events to the hub', (file) => {
    const text = readFileSync(file, 'utf8')
    expect(text).not.toMatch(/@tauri-apps\/api\/event/)
    expect(text).not.toMatch(/\.listen\(\s*['"]tauri:\/\//)
    expect(text).not.toMatch(BITA_LISTENERS)
  })
})
