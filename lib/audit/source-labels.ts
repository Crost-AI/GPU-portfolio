// The change sources in words, for the screens that show or filter them. Pure: no server imports,
// so client components can use it (lib/audit/source.ts carries the async context and is server-only).

export type ChangeSourceKey = 'web' | 'api' | 'mcp'

export const CHANGE_SOURCE_KEYS: readonly ChangeSourceKey[] = ['web', 'api', 'mcp']

export const CHANGE_SOURCE_LABEL: Record<ChangeSourceKey, string> = { web: 'Web', api: 'API', mcp: 'MCP' }

/** A source query parameter, or null for "all" (and for anything not a source). */
export function parseChangeSource(v: unknown): ChangeSourceKey | null {
  return typeof v === 'string' && (CHANGE_SOURCE_KEYS as readonly string[]).includes(v) ? v as ChangeSourceKey : null
}
