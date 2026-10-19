// System source_ref namespaces a person may not type (#82).
//
// A source_ref is the system's tag for what produced an entry, and code trusts it: the GPU fleet
// adopts a `gpu-asset:<id>:…` entry as its own purchase or disposal and counts `gpu-dep:` months as
// booked, `txn:` and `adopted:` tie an entry to the transaction that owns it, the close, allocation,
// intercompany, tax and capital-call code find and void their own entries by ref, and `reversal:<id>`
// says which entry an entry undoes. A user-supplied ref in one of these namespaces forges those
// facts, so EVERY user-authored write path refuses it (assertUserRefAllowed): the journal API and
// the ledger-text import (REST and the post_ledger_text tool), and the assistant's edit proposals;
// only the ledger-text import may write the round-trip export refs below. Internal writers set refs
// directly through persistEntry and are unaffected.
//
// reserved-refs.test.ts scans the code for every prefix a system writer uses and fails when one is
// missing here, so a new system namespace cannot ship unguarded.
export const RESERVED_SOURCE_REF_PREFIXES = [
  // GPU fleet
  'gpu-asset:', 'gpu-dep:', 'fleet:',
  // ── GPU fleet (P2) ── the gross-revenue fee true-up counts every live `gpu-fee:<vehicle>:<YYYY-MM>`
  // entry as fee already booked for that month (lib/gpu/fee.ts), so a typed one would shrink the fee.
  // intercompany_transactions.source_ref carries the same value, but on the charge register, which
  // no journal path writes.
  'gpu-fee:',
  // Allocation, close, tax
  'allocation:', 'agent-allocation:', 'close:', 'tax:', 'schedule:', 'recurring:',
  // Intercompany
  'intercompany:', 'intercompany-settlement:',
  // Transactions, imports and evidence
  'txn:', 'adopted:', 'adopted-remainder:', 'qb:', 'carta:', 'register-import:', 'receipt:', 'partner-opening',
  // Capital calls and distributions
  'call-advance:', 'call-charge:', 'dist-deduction:',
  // Corrections
  'reversal:',
] as const

/**
 * Reserved namespaces the LEDGER-TEXT import may still write, deliberately: the export carries
 * these refs (text-ledger.ts serializeLedger) so that re-importing the same text finds the first
 * import's entries and refuses them as already in the books. Refusing them would break that
 * round trip. The cost is that a forged `txn:` ref through ledger text stays possible (voiding such
 * an entry deletes the transaction it names, via planRelease); that is tracked in #88.
 * Every other reserved namespace, the GPU fleet's included, is unforgeable through user paths.
 */
export const ROUND_TRIP_EXEMPT_PREFIXES = ['txn:', 'qb:', 'adopted:', 'carta:'] as const

export function isReservedSourceRef(ref: unknown): boolean {
  if (typeof ref !== 'string') return false
  const r = ref.trim().toLowerCase()
  return RESERVED_SOURCE_REF_PREFIXES.some(p => r.startsWith(p))
}

/**
 * What a user-authored path refuses: any reserved ref, except a round-trip export ref when the
 * path is the ledger-text import (`allowRoundTrip`), the only place an exported ref legitimately
 * comes back. The journal JSON API and the assistant refuse every reserved ref.
 */
export function isUserForbiddenRef(ref: unknown, opts: { allowRoundTrip?: boolean } = {}): boolean {
  if (!isReservedSourceRef(ref)) return false
  const r = String(ref).trim().toLowerCase()
  return !(opts.allowRoundTrip && ROUND_TRIP_EXEMPT_PREFIXES.some(p => r.startsWith(p)))
}

/** The refusal for a user-supplied source_ref, or null when it may be written. */
export function assertUserRefAllowed(ref: unknown, opts: { allowRoundTrip?: boolean } = {}): string | null {
  return isUserForbiddenRef(ref, opts)
    ? `The reference ${String(ref).trim()} is reserved for entries the system books itself; remove it (or use your own reference).`
    : null
}

/**
 * Draft entries a person may not rewrite by hand: the fleet lifecycle adopts a posted
 * `gpu-asset:`/`gpu-dep:` entry as its own, so its lines must be the ones the lifecycle wrote. Other
 * system drafts (a bank-drafted capital call, a close suggestion) are meant to be corrected by hand.
 */
export const EDIT_LOCKED_PREFIXES = ['gpu-asset:', 'gpu-dep:'] as const

export function isEditLockedRef(ref: unknown): boolean {
  return typeof ref === 'string' && EDIT_LOCKED_PREFIXES.some(p => ref.startsWith(p))
}
