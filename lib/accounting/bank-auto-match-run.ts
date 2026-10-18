// Settle declared calls and distributions from the bank, without being told who.
//
// A capital call and a distribution are DECLARED first (creating a receivable on 1300 or a
// payable on 2300) and settled later when the money actually moves. That declaration is what
// makes settlement inferable: an inflow matching an outstanding receivable, or an outflow
// matching an outstanding payable, is almost never a coincidence.
//
// This finds those, books the settlement as a DRAFT, and links the transaction to it. It
// never posts — posting stays a human act — and it never guesses: anything ambiguous comes
// back for a person to choose, with the candidates attached.

import type { SupabaseClient } from '@supabase/supabase-js'
import { vehicleIdByName } from './vehicle-id'
import { RECEIVABLE_CODE, DISTRIBUTION_PAYABLE_CODE } from './chart'
import { lpReceivableBalances, lpPayableBalances } from './capital-calls'
import { loadEntityNames } from './load'
import { buildFundingEntry, buildDistributionSettlementEntry } from './entries'
import { persistEntry, accountIdByCode } from './persist'
import { matchTransaction, type OpenBalance } from './bank-auto-match'
// ── GPU fleet (P3) ──
import { marketplacePayoutCandidates, type PayoutCandidate } from './bank-match'
import { isPayoutCandidate, matchPayout } from '@/lib/gpu/ops/payouts'
import { RECEIVABLE_CODE as MARKETPLACE_RECEIVABLE_CODE } from '@/lib/gpu/ops/types'

export interface AutoMatchOutcome {
  matched: { txnId: string; lpEntityId: string; name: string; amount: number; by: string }[]
  /** Amount fits several partners and the description didn't separate them — a human picks. */
  ambiguous: { txnId: string; amount: number; description: string | null; candidates: OpenBalance[] }[]
  /** Transactions with no open balance at that amount. Left exactly as they were. */
  unmatched: number
  // ── GPU fleet (P3) ── Present only on a GPU SPV (a chart with 1150), so every other vehicle's
  // outcome has exactly the keys it had before.
  /** Inflows matched to an expected marketplace payout and posted (Dr 1000 / Cr 1150). */
  payouts?: { txnId: string; payoutId: string; amount: number; entryId: string }[]
  /**
   * Inflows that fit several expected payouts, or one payout AND a partner's open call at the same
   * amount (`lpCandidates`) — a human picks.
   */
  ambiguousPayouts?: { txnId: string; amount: number; description: string | null; candidates: PayoutCandidate[]; lpCandidates?: OpenBalance[] }[]
}

const CENT = 0.005

/**
 * @param txnIds restrict to these transactions; omit for every drafted row in the vehicle.
 */
export async function autoMatchOpenCapital(
  admin: SupabaseClient,
  fundId: string,
  group: string,
  userId: string | null,
  txnIds?: string[],
): Promise<AutoMatchOutcome | { error: string }> {
  const vehicleId = await vehicleIdByName(admin, fundId, group)
  const codes = await accountIdByCode(admin, fundId, group)
  const cashId = codes.get('1000')
  if (!cashId) return { error: "The chart is missing account 1000 Cash — add it under the entity's Admin → Chart of accounts." }
  const receivableId = codes.get(RECEIVABLE_CODE)
  const payableId = codes.get(DISTRIBUTION_PAYABLE_CODE)

  let q = (admin as any)
    .from('bank_transactions')
    .select('id, txn_date, amount, description, journal_entry_id, status')
    .eq('fund_id', fundId)
    .eq('vehicle_id', vehicleId)
    .eq('status', 'drafted')
  if (txnIds && txnIds.length > 0) q = q.in('id', txnIds)
  const { data: txns, error } = await q
  if (error) return { error: error.message }

  const [receivables, payables, names, ackRows] = await Promise.all([
    lpReceivableBalances(admin, fundId, group),
    lpPayableBalances(admin, fundId, group),
    loadEntityNames(admin, fundId, group),
    // The wire references partners gave when acknowledging their call notices in the portal —
    // the tiebreak for two partners owing the same amount.
    (admin as any).from('capital_call_lines').select('lp_entity_id, ack_reference')
      .eq('fund_id', fundId).eq('vehicle_id', vehicleId).not('ack_reference', 'is', null),
  ])
  const referencesByLp = new Map<string, string[]>()
  for (const r of (((ackRows as any).data as any[]) ?? [])) {
    if (!r.ack_reference) continue
    referencesByLp.set(r.lp_entity_id, [...(referencesByLp.get(r.lp_entity_id) ?? []), String(r.ack_reference)])
  }

  // Running balances: each settlement consumes the partner's open amount, so two identical
  // wires against ONE open call can't both claim it.
  const openOf = (m: Map<string, number>): OpenBalance[] =>
    Array.from(m.entries())
      .filter(([, amt]) => amt > CENT)
      .map(([lpEntityId, amount]) => ({ lpEntityId, name: names.get(lpEntityId) ?? lpEntityId, amount, references: referencesByLp.get(lpEntityId) ?? [] }))

  const out: AutoMatchOutcome = { matched: [], ambiguous: [], unmatched: 0 }

  // ── GPU fleet (P3) ── Only a GPU SPV's chart has 1150, so for every other vehicle `payouts` stays
  // null and the loop below is the one it always was: no extra read, no extra key in the outcome.
  // Unlike a capital settlement, a payout match POSTS (matchPayout): the payout was declared by a
  // person recording it, and its counter-account is a receivable the posted earnings created.
  let payouts: PayoutCandidate[] | null = null
  if (codes.has(MARKETPLACE_RECEIVABLE_CODE)) {
    payouts = await marketplacePayoutCandidates(admin, fundId, group)
    out.payouts = []
    out.ambiguousPayouts = []
  }

  for (const t of ((txns as any[]) ?? [])) {
    const amount = Number(t.amount)
    const inflow = amount > 0
    if (payouts && inflow) {
      const fits = payouts.filter(p => isPayoutCandidate({ amount: p.amount, payout_date: p.payoutDate }, t))
      // A payout is booked only when no partner's open call fits the same inflow: a wire that could
      // be either is a person's call, never the order of this loop.
      const lp = fits.length ? matchTransaction(amount, t.description, openOf(receivables)) : null
      const lpCandidates = !lp || lp.kind === 'none' ? [] : lp.kind === 'ambiguous' ? lp.candidates : openOf(receivables).filter(o => o.lpEntityId === lp.lpEntityId)
      if (fits.length > 1 || lpCandidates.length) {
        out.ambiguousPayouts!.push({ txnId: t.id, amount, description: t.description, candidates: fits, ...(lpCandidates.length ? { lpCandidates } : {}) })
        continue
      }
      if (fits.length === 1) {
        const matched = await matchPayout(admin, fundId, group, userId, fits[0].payoutId, t.id)
        if ('error' in matched) { out.unmatched++; continue }
        payouts = payouts.filter(p => p.payoutId !== fits[0].payoutId)
        out.payouts!.push({ txnId: t.id, payoutId: fits[0].payoutId, amount, entryId: matched.entryId })
        continue
      }
    }
    const pool = inflow ? receivables : payables
    const settleAccountId = inflow ? receivableId : payableId
    if (!settleAccountId) { out.unmatched++; continue }

    const res = matchTransaction(amount, t.description, openOf(pool))
    if (res.kind === 'none') { out.unmatched++; continue }
    if (res.kind === 'ambiguous') {
      out.ambiguous.push({ txnId: t.id, amount, description: t.description, candidates: res.candidates })
      continue
    }

    const total = Math.abs(amount)
    const memo = `${inflow ? 'Funding' : 'Distribution paid'} — ${res.name}${t.description ? ` — ${t.description}` : ''}`
    const entry = inflow
      ? buildFundingEntry({ fundId, entryDate: t.txn_date, memo }, res.lpEntityId, total, cashId, settleAccountId)
      : buildDistributionSettlementEntry({ fundId, entryDate: t.txn_date, memo }, res.lpEntityId, total, cashId, settleAccountId)

    const saved = await persistEntry(admin, fundId, group, userId, entry, 'draft')
    if ('error' in saved) { out.unmatched++; continue }

    const oldEntryId = t.journal_entry_id
    await (admin as any).from('bank_transactions')
      .update({ journal_entry_id: saved.entryId, suggested_account_code: inflow ? RECEIVABLE_CODE : DISTRIBUTION_PAYABLE_CODE })
      .eq('id', t.id).eq('fund_id', fundId)
    // Retire the placeholder draft this row used to point at. Only ever a DRAFT here: a
    // reconciled row isn't selected, so there is no posted entry to destroy.
    if (oldEntryId && oldEntryId !== saved.entryId) {
      await (admin as any).from('journal_entries').delete()
        .eq('id', oldEntryId).eq('fund_id', fundId).eq('status', 'draft')
    }

    // Consume what this settled, so a second identical wire doesn't match the same call.
    pool.set(res.lpEntityId, (pool.get(res.lpEntityId) ?? 0) - total)
    out.matched.push({ txnId: t.id, lpEntityId: res.lpEntityId, name: res.name, amount, by: res.by })
  }

  return out
}
