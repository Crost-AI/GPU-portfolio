import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// fleet domain (lib/access/route-domains.ts). The middleware has already checked the grant.
import { fleetRequest, needsAccountingWrite } from '@/lib/gpu/ops/http'
import { listPayouts, matchPayout, receivableTieOut, recordPayout } from '@/lib/gpu/ops/payouts'

export const runtime = 'nodejs'

const today = () => new Date().toISOString().slice(0, 10)

// GET ?group= — `{ payouts, receivable }`: every payout (an expected one with its candidate bank
// inflows) and the 1150 tie-out as of today.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const ctx = await fleetRequest(admin, user.id, 'read', req.nextUrl.searchParams.get('group'))
  if (ctx instanceof NextResponse) return ctx
  const [payouts, receivable] = await Promise.all([
    listPayouts(admin, ctx.gate.fundId, ctx.group),
    receivableTieOut(admin, ctx.gate.fundId, ctx.group, today()),
  ])
  if ('error' in payouts) return NextResponse.json(payouts, { status: 400 })
  if ('error' in receivable) return NextResponse.json(receivable, { status: 400 })
  return NextResponse.json({
    payouts: payouts.map(p => ({
      id: p.id, payoutDate: p.payout_date, amount: Number(p.amount), reference: p.reference, note: p.note, status: p.status,
      bankTransactionId: p.bank_transaction_id, entryId: p.journal_entry_id,
      candidates: p.candidates.map(t => ({ id: t.id, txnDate: t.txn_date, amount: Number(t.amount), description: t.description, status: t.status })),
    })),
    receivable,
  })
}

// POST { group, action: 'record', date, amount, reference?, note? } records an expected payout;
// { group, action: 'match', payoutId, txnId } books it against a bank inflow (accounting write too).
export async function POST(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await req.json().catch(() => ({}))
  const ctx = await fleetRequest(admin, user.id, 'write', body?.group)
  if (ctx instanceof NextResponse) return ctx

  if (body?.action === 'record') {
    const result = await recordPayout(admin, ctx.gate.fundId, ctx.group, user.id, body)
    if ('error' in result) return NextResponse.json(result, { status: 400 })
    return NextResponse.json(result)
  }
  if (body?.action !== 'match') return NextResponse.json({ error: "action must be 'record' or 'match'" }, { status: 400 })
  const denied = needsAccountingWrite(ctx.access, 'Matching a payout')
  if (denied) return denied
  if (typeof body?.payoutId !== 'string' || typeof body?.txnId !== 'string') return NextResponse.json({ error: 'payoutId and txnId are required' }, { status: 400 })
  const result = await matchPayout(admin, ctx.gate.fundId, ctx.group, user.id, body.payoutId, body.txnId)
  if ('error' in result) return NextResponse.json(result, { status: 400 })
  return NextResponse.json(result)
}
