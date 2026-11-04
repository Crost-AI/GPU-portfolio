import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupWithAccess } from '@/lib/accounting/http-vehicle'
import { buildStatementPackage } from '@/lib/accounting/statement-package'
import { canSeeAccruedMemo } from '@/lib/gpu/accrued'

// GET — the full statement package for a vehicle, scoped to a statement period:
//   ?preset=this_quarter|last_quarter|ytd|prior_year|itd   — or —
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// The period means different things to different statements, and that distinction
// is the whole point:
//   • Balance sheet, trial balance, SOI  → POINT IN TIME, cumulative to `end`.
//   • Income statement, cash flows       → OVER TIME, only activity within the window.
//   • Capital accounts                   → both: opens with the balance carried in.
//
// The load + compute lives in buildStatementPackage so the on-screen statements and
// the Excel workpaper export (statements/export) can never disagree.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const resolved = await resolveGroupWithAccess(admin, gate, req.nextUrl.searchParams.get('group'))
  if (resolved instanceof NextResponse) return resolved
  const { group, access } = resolved

  // The statement of changes in partners' capital used to be withheld here from a caller without
  // lp_capital. It was theatre: the trial balance below ships the same partners and the same
  // balances, because a fund's chart has one NAMED capital account per partner. Reading the books
  // is reading partner capital — so `accounting` now implies `lp_capital` outright
  // (see DOMAIN_META.lp_capital.impliedBy) and this package is whole again.

  // A GPU SPV's accrued profit share is a memo of the manager's economics: on the same gate as its
  // own route (gp_economics, gpu_fleet on, the books' read).
  const accruedMemo = canSeeAccruedMemo(access)
  const pkg = await buildStatementPackage(admin, gate.fundId, group, req.nextUrl.searchParams, { accruedMemo })
  return NextResponse.json(pkg.comparisons ? { ...pkg.payload, comparisons: pkg.comparisons } : pkg.payload)
}
