export interface PendientesTarget {
  space: string | null
  key: string | null
}

export function parsePendientesPath(path: readonly string[]): PendientesTarget {
  const [space, key] = path
  return { space: space === undefined || space === '_' ? null : space, key: key ?? null }
}

export function pendientesRoute(space: string | null, key: string | null = null): string {
  const parts = ['pendientes']
  if (space !== null || key !== null) parts.push(space ?? '_')
  if (key !== null) parts.push(key)
  return parts.map(encodeURIComponent).join('/')
}
