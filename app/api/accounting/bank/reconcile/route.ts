import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { vehicleIdByName } from '@/lib/accounting/vehicle-id'
import { fetchAllRows, loadPostedLedger } from '@/lib/accounting/load'
import { accountBalances } from '@/lib/accounting/ledger'
import { cashTransferEntryIds, openingCashBefore, summarizeBankRec, type BankTxnState } from '@/lib/accounting/bank'

// GET — bank reconciliation for a vehicle: ledger cash vs the bank feed.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const group = await resolveGroupOr400(admin, gate, req.nextUrl.searchParams.get('group'))
  if (group instanceof NextResponse) return group

  const { accounts, postings, sourcedPostings } = await loadPostedLedger(admin, gate.fundId, group)
  const cash = accounts.find(a => a.code === '1000')
  const ledgerCashBalance = cash ? (accountBalances(postings).get(cash.id) ?? 0) : 0

  const vehicleId = await vehicleIdByName(admin, gate.fundId, group)
  // Paged: the opening balance needs the feed's first date and the summary every row, and a read
  // stopping at PostgREST's row cap would disagree with bank_reconciliation and close readiness.
  const rows = await fetchAllRows<any>((from, to) => (admin as any)
    .from('bank_transactions')
    .select('id, txn_date, amount, status, journal_entry_id')
    .eq('fund_id', gate.fundId)
    .eq('vehicle_id', vehicleId)
    .neq('status', 'ignored')
    .range(from, to))
  const transfers = cashTransferEntryIds(sourcedPostings, cash?.id)
  const txns: BankTxnState[] = rows.map(t => ({ amount: Number(t.amount), matched: t.status === 'reconciled', cashTransfer: transfers.has(t.journal_entry_id) }))

  return NextResponse.json(summarizeBankRec(txns, ledgerCashBalance, openingCashBefore(postings, cash?.id, rows.map(t => t.txn_date))))
}
