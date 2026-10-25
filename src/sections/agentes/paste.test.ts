import { describe, expect, it, vi } from 'vitest'
import { cleanPaste, guardPaste } from './paste.ts'

function pasteEvent(text: string): Event {
  const event = new Event('paste', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'clipboardData', { value: { getData: (kind: string) => (kind === 'text/plain' ? text : '') } })
  return event
}

describe('cleanPaste', () => {
  it('drops every control character but newline and tab, like the backend', () => {
    expect(cleanPaste('a\u0000b\u0007c\u0008d\re\u001bf\u007fg\u009bh\ni\tj')).toBe('abcdefgh\ni\tj')
  })

  it('cannot leave an end of paste marker behind', () => {
    expect(cleanPaste('hola\u001b[201~rm -rf /\n')).toBe('hola[201~rm -rf /\n')
    expect(cleanPaste('a\u001b[20\u001b[201~1~b')).not.toContain('\u001b')
  })
})

describe('guardPaste', () => {
  it('takes the paste away from the terminal and hands over the cleaned text', () => {
    const host = document.createElement('div')
    const textarea = document.createElement('textarea')
    host.append(textarea)
    const inner = vi.fn()
    textarea.addEventListener('paste', inner)
    const pasted: string[] = []
    const release = guardPaste(host, (text) => pasted.push(text))
    const event = pasteEvent('ls\u001b[201~\u001b[200~whoami\r\n')
    textarea.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(inner).not.toHaveBeenCalled()
    expect(pasted).toEqual(['ls[201~[200~whoami\n'])
    textarea.dispatchEvent(pasteEvent('\u001b\u0003'))
    expect(pasted).toHaveLength(1)
    release()
    textarea.dispatchEvent(pasteEvent('again'))
    expect(inner).toHaveBeenCalledTimes(1)
    expect(pasted).toHaveLength(1)
  })
})
