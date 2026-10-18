// System source_ref namespaces a person may not type (#82).
//
// A source_ref is the system's tag for what produced an entry, and several code paths trust it: the
// GPU fleet lifecycle adopts an entry carrying `gpu-asset:<id>:…` as its own purchase or disposal,
// `gpu-dep:` marks a month's depreciation as booked, the close and intercompany settle by their
// refs, and `reversal:<id>` says which entry an entry undoes. A user-supplied ref in one of these
// namespaces would forge those facts, so the journal API refuses it. Internal writers set them
// directly through persistEntry and are unaffected.
export const RESERVED_SOURCE_REF_PREFIXES = [
  'gpu-asset:', 'gpu-dep:', 'fleet:',
  'allocation:', 'agent-allocation:',
  'intercompany:', 'intercompany-settlement:',
  'reversal:',
] as const

export function isReservedSourceRef(ref: unknown): boolean {
  if (typeof ref !== 'string') return false
  const r = ref.trim().toLowerCase()
  return RESERVED_SOURCE_REF_PREFIXES.some(p => r.startsWith(p))
}
