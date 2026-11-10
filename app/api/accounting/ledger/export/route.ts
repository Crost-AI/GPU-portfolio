import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// accounting domain (lib/access/route-domains.ts).
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { rateLimit } from '@/lib/rate-limit'
import { loadPostedLedger } from '@/lib/accounting/load'
import { findAccount } from '@/lib/accounting/register'
import { resolvePeriod, customPeriod, type PeriodPreset } from '@/lib/accounting/statement-period'
import { booksForBasis, basisFromParam } from '@/lib/accounting/statement-package'
import { generalLedgerRows } from '@/lib/accounting/journal-export'
import { toCsv } from '@/lib/accounting/csv'

// GET — the general ledger as a file: every account's register (opening balance, each posted
// line with what it was booked against, running balance, closing balance) in one table.
//   ?format=xlsx (default) | csv
//   ?preset=… or ?start=&end=    the same window the ledger page shows (default YTD)
//   ?account=<code or id>        one account's register instead of the whole chart
//   ?basis=tax                   the ledger plus the book-to-tax overlay, as the statements do
//
// Reads the POSTED ledger through the same loader as /api/accounting/ledger, so each closing
// balance is the trial balance to the cent. The tax package's general-ledger CSV is these rows.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const sp = req.nextUrl.searchParams
  const group = await resolveGroupOr400(admin, gate, sp.get('group'))
  if (group instanceof NextResponse) return group

  const limited = await rateLimit({ key: `ledger-export:${user.id}`, limit: 30, windowSeconds: 300 })
  if (limited) return limited

  const preset = (sp.get('preset') as PeriodPreset | null) ?? 'ytd'
  const period = preset === 'custom' ? customPeriod(sp.get('start'), sp.get('end')) : resolvePeriod(preset)
  const basis = basisFromParam(sp.get('basis'))
  const format = sp.get('format') ?? 'xlsx'

  const { accounts, sourcedPostings } = await loadPostedLedger(
    admin, gate.fundId, group, undefined, undefined, undefined, booksForBasis(basis),
  )
  const ref = sp.get('account')
  const account = ref ? findAccount(accounts, ref) : null
  if (ref && !account) return NextResponse.json({ error: `No account "${ref}" in this vehicle's chart` }, { status: 404 })

  const rows = generalLedgerRows(accounts, sourcedPostings, period, { only: account?.id })
  const stem = ['general-ledger', group, account?.code, basis === 'tax' ? 'tax' : null, period.start ?? 'inception', period.end ?? 'today']
    .filter(Boolean).join('-').replace(/[^a-zA-Z0-9\-]/g, '-')

  if (format === 'csv') {
    return new NextResponse(toCsv(rows), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${stem}.csv"`,
      },
    })
  }

  const ws = XLSX.utils.aoa_to_sheet(rows)
  ws['!cols'] = [{ wch: 12 }, { wch: 32 }, { wch: 11 }, { wch: 10 }, { wch: 14 }, { wch: 40 }, { wch: 18 }, { wch: 14 }, { wch: 14 }, { wch: 14 }]
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: rows[0].length - 1 } }) }
  // Money columns (Debit, Credit, Balance) as two-decimal numbers, negatives in parentheses.
  for (let r = 1; r < rows.length; r++) {
    for (const c of [7, 8, 9]) {
      const cell = ws[XLSX.utils.encode_cell({ r, c })]
      if (cell && cell.t === 'n') cell.z = '#,##0.00;(#,##0.00)'
    }
  }
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'General ledger')
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${stem}.xlsx"`,
    },
  })
}
