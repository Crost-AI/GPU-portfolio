// ── GPU fleet (P3) ── The operations subledger's pre-close checks for a GPU SPV, called from
// checkReadiness (lib/accounting/close.ts). Kept here so close.ts carries one labelled call.

import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows, loadPostedLedger } from '@/lib/accounting/load'
import { receivableTieOut } from './payouts'
import { FEE_CODE, REVENUE_CODE } from './types'

const cents = (n: number) => Math.round(Number(n) * 100)
const money = (c: number) => (c / 100).toFixed(2)

/**
 * Over [start, end]:
 *   - blocker: posted rows' gross ≠ 4000 posted activity, or their fees ≠ 5150 activity (to the
 *     cent) — revenue reached the ledger outside the subledger, or the reverse;
 *   - blocker: an unmatched row (revenue entered against no server, so it can never post);
 *   - warning: a staged row (revenue entered but not posted);
 *   - warning: 1150 at `end` ≠ posted net − matched payouts.
 */
export async function gpuOpsCloseIssues(
  admin: SupabaseClient, fundId: string, group: string, vehicleId: string, start: string, end: string,
): Promise<{ blockers: string[]; warnings: string[] }> {
  const blockers: string[] = []
  const warnings: string[] = []

  const [rows, ledger] = await Promise.all([
    fetchAllRows<{ status: string; gross: number; marketplace_fee: number }>((f, t) => (admin as any).from('gpu_earnings')
      .select('id, status, gross, marketplace_fee').eq('fund_id', fundId).eq('vehicle_id', vehicleId)
      .gte('period_end', start).lte('period_end', end).range(f, t)),
    loadPostedLedger(admin, fundId, group, end),
  ])

  const posted = rows.filter(r => r.status === 'posted')
  const ids = new Map(ledger.accounts.map(a => [a.id, a.code]))
  const activity = (code: string) => ledger.postings
    .filter(p => ids.get(p.accountId) === code && (p.entryDate ?? '') >= start)
    .reduce((s, p) => s + cents(p.amount), 0)
  const subGross = posted.reduce((s, r) => s + cents(r.gross), 0)
  const subFee = posted.reduce((s, r) => s + cents(r.marketplace_fee), 0)
  const ledgerRevenue = -activity(REVENUE_CODE)
  const ledgerFee = activity(FEE_CODE)
  if (subGross !== ledgerRevenue) {
    blockers.push(`GPU revenue does not tie: posted operations entries total ${money(subGross)} gross, but 4000 Rental revenue shows ${money(ledgerRevenue)} for this span. Find the entry booked outside GPU operations (or the operations entry not on the books) before closing.`)
  }
  if (subFee !== ledgerFee) {
    blockers.push(`Marketplace fees do not tie: posted operations entries total ${money(subFee)}, but 5150 shows ${money(ledgerFee)} for this span.`)
  }

  const unmatched = rows.filter(r => r.status === 'unmatched').length
  if (unmatched) {
    blockers.push(`${unmatched} GPU operations row${unmatched === 1 ? '' : 's'} in this span match${unmatched === 1 ? 'es' : ''} no server. Correct the asset name and enter it again, or ignore the row, on the Revenue page.`)
  }
  const staged = rows.filter(r => r.status === 'staged').length
  if (staged) {
    warnings.push(`${staged} GPU operations row${staged === 1 ? ' is' : 's are'} entered but not posted in this span: that revenue is not in the books yet.`)
  }

  const tie = await receivableTieOut(admin, fundId, group, end)
  if ('error' in tie) throw new Error(tie.error)
  if (cents(tie.difference) !== 0) {
    warnings.push(`1150 Marketplace receivable is ${tie.ledger1150.toFixed(2)} at ${end}, but posted net revenue less matched payouts is ${tie.expected.toFixed(2)} (difference ${tie.difference.toFixed(2)}).`)
  }
  return { blockers, warnings }
}
