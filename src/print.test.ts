import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isPrinting, printRoot, printWith, type PrintSource } from './print.ts'

const SRC = join(process.cwd(), 'src') + sep

const SHEETS: Record<PrintSource, string[]> = {
  tiempo: ['sections/tiempo/reportes.css'],
  docs: ['notes/notes.css', 'notes/export.css', 'sections/docs/docs.css'],
}

function files(dir: string, suffix: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return files(path, suffix)
    return path.endsWith(suffix) ? [path] : []
  })
}

function shell(): void {
  document.head.replaceChildren()
  document.body.className = ''
  document.body.replaceChildren()
  const root = document.createElement('div')
  root.className = 'shell'
  const content = document.createElement('main')
  content.className = 'content'
  for (const section of ['tiempo', 'docs']) {
    const host = document.createElement('section')
    host.className = 'section-host'
    host.dataset['section'] = section
    const inner = document.createElement('div')
    inner.className = section === 'docs' ? 'notes-root docs' : 'report-root'
    host.append(inner)
    content.append(host)
  }
  root.append(content)
  document.body.append(root)
}

function load(relative: string): void {
  const style = document.createElement('style')
  style.textContent = readFileSync(join(SRC, relative), 'utf8')
  document.head.append(style)
}

function visit(order: PrintSource[]): void {
  load('print.css')
  for (const source of order) for (const sheet of SHEETS[source]) load(sheet)
}

function printHiding(): string[] {
  const selectors: string[] = []
  for (const sheet of [...document.styleSheets]) {
    for (const rule of [...sheet.cssRules]) {
      if (!(rule instanceof CSSMediaRule) || !rule.media.mediaText.includes('print')) continue
      for (const inner of [...rule.cssRules]) {
        if (inner instanceof CSSStyleRule && inner.style.getPropertyValue('display') === 'none') {
          selectors.push(inner.selectorText)
        }
      }
    }
  }
  return selectors
}

function hiddenInPrint(node: Element): boolean {
  const selectors = printHiding()
  for (let current: Element | null = node; current !== null; current = current.parentElement) {
    if (selectors.some((selector) => current.matches(selector))) return true
  }
  return false
}

function fill(root: HTMLElement): HTMLElement {
  const page = document.createElement('section')
  page.className = 'paper print-page'
  root.append(page)
  return page
}

afterEach(() => {
  document.body.className = ''
  document.body.replaceChildren()
  document.head.replaceChildren()
})

describe('print root', () => {
  it('keeps the docs export visible after visiting Tiempo', async () => {
    shell()
    visit(['tiempo', 'docs'])
    const root = printRoot('docs', 'notes-root')
    const page = fill(root)
    await printWith(root, async () => {
      expect(isPrinting()).toBe(true)
      expect(root.parentElement).toBe(document.body)
      expect(root.classList.contains('print-root--docs')).toBe(true)
      expect(root.classList.contains('notes-root')).toBe(true)
      expect(document.querySelectorAll('#print-root')).toHaveLength(1)
      expect(hiddenInPrint(page)).toBe(false)
      expect(hiddenInPrint(document.querySelector('.shell') as Element)).toBe(true)
    })
    expect(isPrinting()).toBe(false)
    expect(document.getElementById('print-root')).toBeNull()
  })

  it('keeps the Tiempo export visible after visiting docs', async () => {
    shell()
    visit(['docs', 'tiempo'])
    const stale = printRoot('docs', 'notes-root')
    const root = printRoot('tiempo')
    expect(stale.isConnected).toBe(false)
    const page = fill(root)
    await printWith(root, async () => {
      expect(root.parentElement).toBe(document.body)
      expect(root.dataset['print']).toBe('tiempo')
      expect(root.classList.contains('notes-root')).toBe(false)
      expect(hiddenInPrint(page)).toBe(false)
      expect(hiddenInPrint(document.querySelector('.section-host[data-section="docs"]') as Element)).toBe(true)
    })
    expect(document.getElementById('print-root')).toBeNull()
  })

  it('clears the printing state when the export fails', async () => {
    shell()
    const root = printRoot('tiempo')
    await expect(printWith(root, () => Promise.reject(new Error('sin permiso')))).rejects.toThrow('sin permiso')
    expect(isPrinting()).toBe(false)
    expect(root.isConnected).toBe(false)
  })

  it('keeps print rules in the shared stylesheet only', () => {
    const owners = files(SRC, '.css').filter((path) => /@media\s+print|@page/.test(readFileSync(path, 'utf8')))
    expect(owners.map((path) => path.slice(SRC.length))).toEqual(['print.css'])
  })

  it('builds every print root through the shared module', () => {
    const owners = files(SRC, '.ts').filter(
      (path) => !path.endsWith('.test.ts') && readFileSync(path, 'utf8').includes("'print-root'"),
    )
    expect(owners.map((path) => path.slice(SRC.length))).toEqual(['print.ts'])
  })
})

describe('drag regions', () => {
  it('only the shell top bar and the assistant mini window drag the window', () => {
    const owners = files(SRC, '.ts').filter(
      (path) => !path.endsWith('.test.ts') && readFileSync(path, 'utf8').includes('data-tauri-drag-region'),
    )
    expect(owners.map((path) => path.slice(SRC.length)).sort()).toEqual(['live.ts', 'shell/topbar.ts'])
  })
})
