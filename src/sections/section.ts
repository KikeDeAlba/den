export interface SectionModule {
  mount(host: HTMLElement, path: readonly string[]): void | Promise<void>
  update(path: readonly string[]): void
  unmount(): void
  keepAlive?: boolean
}
