import type { PreviewResult } from './types'

/**
 * What stops a draft from being staged at all: the blockers its preview's checks list
 * (`details.flags`, lib/drafting/checks.ts). Staging something that can never be approved only
 * puts a dead row in front of the approver. Null when nothing blocks.
 */
export function previewBlockers(preview: PreviewResult): string | null {
  const flags = (preview.details as { flags?: unknown }).flags
  if (!Array.isArray(flags)) return null
  const blockers = flags.filter((f: any) => f?.severity === 'blocker').map((f: any) => String(f.message ?? f.code))
  return blockers.length ? `Not staged: ${blockers.join(' ')}` : null
}
