import { mountPanel, refreshPanel } from './panel.ts'
import './ahora.css'

export function mount(host: HTMLElement): void {
  mountPanel(host)
}

export function update(): void {
  refreshPanel()
}

export function unmount(): void {}
