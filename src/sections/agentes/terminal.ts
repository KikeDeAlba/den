import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal, type ITheme } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { binaryBytes } from './outbox.ts'
import { guardPaste } from './paste.ts'

export interface TerminalHooks {
  input(data: string): void
  bytes(data: Uint8Array): void
  resize(cols: number, rows: number): void
}

export interface TerminalView {
  readonly element: HTMLElement
  size(): { cols: number; rows: number }
  write(bytes: Uint8Array): void
  show(): void
  hide(): void
  focus(): void
  dispose(): void
}

export const THEME: ITheme = {
  background: '#1d2021',
  foreground: '#ebdbb2',
  cursor: '#ebdbb2',
  cursorAccent: '#1d2021',
  selectionBackground: '#504945',
  black: '#282828',
  red: '#cc241d',
  green: '#98971a',
  yellow: '#d79921',
  blue: '#458588',
  magenta: '#b16286',
  cyan: '#689d6a',
  white: '#a89984',
  brightBlack: '#928374',
  brightRed: '#fb4934',
  brightGreen: '#b8bb26',
  brightYellow: '#fabd2f',
  brightBlue: '#83a598',
  brightMagenta: '#d3869b',
  brightCyan: '#8ec07c',
  brightWhite: '#ebdbb2',
}

const FONT = "'IBM Plex Mono', ui-monospace, monospace"

export function createTerminal(hooks: TerminalHooks): TerminalView {
  const element = document.createElement('div')
  element.className = 'agentes-xterm'
  const terminal = new Terminal({
    fontFamily: FONT,
    fontSize: 12,
    lineHeight: 1.25,
    theme: THEME,
    cursorBlink: true,
    scrollback: 10_000,
    macOptionIsMeta: true,
    allowProposedApi: false,
  })
  const fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.onData((data) => hooks.input(data))
  terminal.onBinary((data) => hooks.bytes(binaryBytes(data)))
  terminal.onResize(({ cols, rows }) => hooks.resize(cols, rows))
  const releasePaste = guardPaste(element, (text) => terminal.paste(text))

  let opened = false
  let visible = false
  let webgl: WebglAddon | null = null
  let frame = 0

  function refit(): void {
    if (!opened || !visible || element.clientWidth === 0 || element.clientHeight === 0) return
    try {
      fit.fit()
    } catch {
      return
    }
  }

  function scheduleFit(): void {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(refit)
  }

  const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(scheduleFit)

  function enableWebgl(): void {
    if (webgl !== null) return
    try {
      const addon = new WebglAddon()
      addon.onContextLoss(() => disableWebgl())
      terminal.loadAddon(addon)
      webgl = addon
    } catch {
      webgl = null
    }
  }

  function disableWebgl(): void {
    const addon = webgl
    webgl = null
    addon?.dispose()
  }

  return {
    element,
    size: () => ({ cols: terminal.cols, rows: terminal.rows }),
    write(bytes) {
      terminal.write(bytes)
    },
    show() {
      visible = true
      if (!opened && element.isConnected) {
        terminal.open(element)
        opened = true
        observer?.observe(element)
        void document.fonts?.ready.then(scheduleFit)
      }
      if (!opened) return
      enableWebgl()
      refit()
    },
    hide() {
      visible = false
      disableWebgl()
    },
    focus() {
      terminal.focus()
    },
    dispose() {
      cancelAnimationFrame(frame)
      observer?.disconnect()
      disableWebgl()
      releasePaste()
      terminal.dispose()
      element.remove()
    },
  }
}
