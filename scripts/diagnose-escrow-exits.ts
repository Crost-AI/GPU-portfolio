// Read-only: every exit with escrow, beside what the ledger booked for it.
//
//   npx tsx --env-file=.env.local scripts/diagnose-escrow-exits.ts                 # every fund
//   npx tsx --env-file=.env.local scripts/diagnose-escrow-exits.ts <fund_id> ["<vehicle name>"]
//
// Writes nothing. `proceeds_received` is the GROSS proceeds of an exit, escrow included
// (lib/portfolio/proceeds.ts), and an exit books gross − escrow to cash. Exits recorded before that
// was settled were booked with proceeds_received as the cash received. For each one, compare
// "booked cash" with what the bank received on the exit date:
//
//   READING old_rule / old_rule_no_1350 (booked cash = proceeds_received)
//     bank received booked cash          → Proceeds was entered net. Books are right. Edit the exit's
//                                          Proceeds to proceeds_received + escrow (the "gross if net"
//                                          column); the re-derived entry books the same cash.
//     bank received booked cash − escrow → Proceeds was entered gross. Cash and realized gain are
//                                          overstated by the escrow. Re-save the exit; it re-books.
//     An ADOPTED row (entry owner "adopted") was always stored net by adoption: the books are right,
//     and supabase/pending-deploy/adopted_exit_proceeds_gross.sql restates the row as gross. Editing
//     it before then is refused ("can't be split"), which leaves the books alone.
//   READING not_on_ledger → decide the meaning BEFORE putting it on the ledger: it will be booked as gross.
//   READING other         → the entry was changed by hand; reconcile it from the journal.
//   READING gross         → booked by the current rule; nothing to do.

import { createAdminClient } from '@/lib/supabase/admin'
import { loadEscrowExits } from '@/lib/accounting/escrow-exit-review'

const [fundArg, vehicleArg] = process.argv.slice(2)
const admin: any = createAdminClient()
const money = (n: number | null | undefined) => n == null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

async function main() {
  const funds: { id: string; name: string }[] = fundArg
    ? [{ id: fundArg, name: fundArg }]
    : (((await admin.from('funds').select('id, name')).data as any[]) ?? [])
  let total = 0
  for (const f of funds) {
    const rows = await loadEscrowExits(admin, f.id, vehicleArg ? { vehicles: [vehicleArg] } : {})
    if (rows.length === 0) continue
    console.log(`\n=== ${f.name} (${f.id}) — ${rows.length} exit${rows.length === 1 ? '' : 's'} with escrow`)
    for (const r of rows) {
      total++
      console.log(`\n${r.date ?? '(no date)'}  ${r.company}  [${r.vehicle ?? 'no vehicle'}]${r.roundName ? `  ${r.roundName}` : ''}`)
      console.log(`  txn ${r.txnId}   entry ${r.entryId ?? '—'} (${r.entryOwner ?? 'none'}, ${r.entryStatus ?? '—'})`)
      console.log(`  stored     proceeds_received ${money(r.proceedsReceived)}   escrow ${money(r.proceedsEscrow)}   basis ${money(r.basis)}   escrow released since ${money(r.escrowReleased)}`)
      console.log(`  booked     cash ${money(r.booked?.cash)}   1350 ${money(r.booked?.escrow)}   realized gain ${money(r.booked?.gain)}`)
      console.log(`  gross rule cash ${money(r.expected.cash)}   1350 ${money(r.expected.escrow)}   realized gain ${money(r.expected.gain)}`)
      console.log(`  gross if proceeds_received was net: ${money(r.proceedsReceived + r.proceedsEscrow)}`)
      console.log(`  READING ${r.reading}${r.cashDifference ? `   cash differs from the gross rule by ${money(r.cashDifference)}` : ''}`)
    }
  }
  console.log(total === 0 ? '\nNo exits with escrow.' : `\n${total} exit${total === 1 ? '' : 's'} listed. Nothing was changed.`)
}

main().catch(e => { console.error(e); process.exit(1) })
