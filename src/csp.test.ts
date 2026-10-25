import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SRC = join(ROOT, 'src')

function read(path: string): string {
  return readFileSync(path, 'utf8')
}

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path)
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
}

describe('content security policy', () => {
  it('blocks plugins, base rewrites and form posts', () => {
    const config = JSON.parse(read(join(ROOT, 'src-tauri', 'tauri.conf.json'))) as { app: { security: { csp: string } } }
    const csp = config.app.security.csp
    for (const directive of ["object-src 'none'", "base-uri 'none'", "form-action 'none'", "default-src 'self'"]) {
      expect(csp).toContain(directive)
    }
  })

  it('handles every form submit in script so form-action none never blocks it', () => {
    for (const file of files(SRC)) {
      const text = read(file)
      for (const match of text.matchAll(/addEventListener\('submit',[^\n]*\n([^\n]*\n){0,2}/g)) {
        expect(match[0], file).toContain('preventDefault')
      }
    }
  })
})
