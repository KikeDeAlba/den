const PROJECT_COLORS = [
  'var(--aqua)',
  'var(--blue)',
  'var(--purple)',
  'var(--ok)',
  'var(--estimate)',
] as const

export function projectColor(projectId: number | null): string {
  if (projectId === null) return 'var(--fg-faint)'
  return PROJECT_COLORS[projectId % PROJECT_COLORS.length] ?? 'var(--fg-faint)'
}
