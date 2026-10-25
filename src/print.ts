import './print.css'
import { element } from './dom.ts'

export type PrintSource = 'docs' | 'tiempo'

const PRINTING = 'printing'
const ROOT_ID = 'print-root'

export function printRoot(source: PrintSource, ...classes: string[]): HTMLElement {
  document.getElementById(ROOT_ID)?.remove()
  const root = element('div', [ROOT_ID, `${ROOT_ID}--${source}`, ...classes].join(' '))
  root.id = ROOT_ID
  root.dataset['print'] = source
  document.body.append(root)
  return root
}

export async function printWith<T>(root: HTMLElement, run: () => Promise<T>): Promise<T> {
  document.body.classList.add(PRINTING)
  try {
    return await run()
  } finally {
    document.body.classList.remove(PRINTING)
    root.remove()
  }
}

export function isPrinting(): boolean {
  return document.body.classList.contains(PRINTING)
}
