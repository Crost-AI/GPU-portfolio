// Owned, leased claims on gpu_earnings and gpu_payouts rows: how postEarnings and matchPayout make
// sure exactly one request books a row, and that an abandoned claim does not strand it.
//
//   - TAKE: one conditional update — status → the in-progress state, a fresh claim_token, claimed_at
//     now — where the row is still in the expected prior state. Proceed only if one row changed.
//   - FINISH / RELEASE: a conditional update where claim_token is MY token. A request that does not
//     hold the token never releases or clears anything.
//   - FENCE: the holder renews its lease (claimed_at, conditional on its token) immediately before
//     every journal write, and aborts before the insert when it has lost the token to a takeover.
//   - A request that finds the row claimed by someone else and the claim still LIVE answers "in
//     progress" and judges no evidence: the holder may still be inside persistEntry, whose posted
//     entry can yet be discarded. Once the claim has EXPIRED it does exactly one of: COMPLETE it from
//     the entry the holder was booking, now posted (conditional on the token it observed with that
//     evidence); name a draft left under the ref, to post or void; or TAKE IT OVER (conditional on
//     the old token) when nothing was booked.
//
// The residual race — a holder that pauses for longer than the lease between its fence and its
// insert — is loud rather than silent: the close blocks on a second live entry under one ref.

import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'

/** How long a claim with nothing booked is honoured before another request may take it over. */
export const CLAIM_LEASE_MS = 120_000

export type ClaimTable = 'gpu_earnings' | 'gpu_payouts'

export interface ClaimScope { fundId: string; vehicleId: string }

export interface ClaimedRow { id: string; status: string; claim_token: string | null; claimed_at: string | null }

const now = () => new Date().toISOString()

async function update(
  admin: SupabaseClient, table: ClaimTable, scope: ClaimScope, id: string,
  where: (q: any) => any, values: Record<string, unknown>,
): Promise<boolean> {
  const q = (admin as any).from(table).update({ ...values, updated_at: now() })
    .eq('fund_id', scope.fundId).eq('vehicle_id', scope.vehicleId).eq('id', id)
  const { data, error } = await where(q).select('id')
  if (error) throw error
  return ((data as any[]) ?? []).length === 1
}

/** Take a claim on a row still in `from`. Returns my token, or null when someone else got there. */
export async function takeClaim(
  admin: SupabaseClient, table: ClaimTable, scope: ClaimScope, id: string, from: string, to: string, extra: Record<string, unknown> = {},
): Promise<string | null> {
  const token = randomUUID()
  const won = await update(admin, table, scope, id, q => q.eq('status', from), { status: to, claim_token: token, claimed_at: now(), ...extra })
  return won ? token : null
}

/** Whether a claim has outlived its lease. */
export function isStale(row: Pick<ClaimedRow, 'claimed_at'>, at = Date.now()): boolean {
  return !row.claimed_at || at - Date.parse(row.claimed_at) > CLAIM_LEASE_MS
}

/** Take over an expired claim, conditional on the token it still carries. Returns my new token, or null. */
export async function takeOver(admin: SupabaseClient, table: ClaimTable, scope: ClaimScope, row: ClaimedRow): Promise<string | null> {
  if (!isStale(row)) return null
  const token = randomUUID()
  const won = await update(admin, table, scope, row.id,
    q => (row.claim_token ? q.eq('claim_token', row.claim_token) : q.is('claim_token', null)).eq('status', row.status),
    { claim_token: token, claimed_at: now() })
  return won ? token : null
}

/** Finish or release MY claim: set `values` and clear the claim, only while I still hold it. */
export async function settleClaim(
  admin: SupabaseClient, table: ClaimTable, scope: ClaimScope, id: string, token: string, values: Record<string, unknown>,
): Promise<boolean> {
  return update(admin, table, scope, id, q => q.eq('claim_token', token), { ...values, claim_token: null, claimed_at: null })
}

/** The fence: renew MY lease right before a journal write. False = I lost the token; do not write. */
export async function renewClaim(admin: SupabaseClient, table: ClaimTable, scope: ClaimScope, id: string, token: string): Promise<boolean> {
  return update(admin, table, scope, id, q => q.eq('claim_token', token), { claimed_at: now() })
}

/**
 * Complete an EXPIRED claim from durable evidence: only while the row is still in `inProgress` and
 * still carries the token observed together with that evidence. False = someone else moved it.
 */
export async function completeFromEvidence(
  admin: SupabaseClient, table: ClaimTable, scope: ClaimScope, row: ClaimedRow, values: Record<string, unknown>,
): Promise<boolean> {
  return update(admin, table, scope, row.id,
    q => (row.claim_token ? q.eq('claim_token', row.claim_token) : q.is('claim_token', null)).eq('status', row.status),
    { ...values, claim_token: null, claimed_at: null })
}
