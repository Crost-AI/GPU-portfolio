'use client'

import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { EmptyState } from '@/components/ui/empty-state'
import { prefLedgerTotals, type PrefLedgerRow } from './waterfall-api'

// ── GPU fleet (P5) ── The carried-forward preferred-return ledger: one row per event (a
// contribution or a distribution), derived by the route from the books every time. Each row's
// identity: brought forward + accrued − paid = carried forward. No manager figures.

const num = 'px-3 py-2 text-right tabular-nums'
const head = 'whitespace-nowrap px-3 py-2 font-medium'

/** A 400 from the route: the vehicle has other terms, or the replay could not run. Not an error toast. */
export function PrefLedgerUnavailable({ message }: { message: string }) {
  return (
    <Alert data-region="pref-ledger-unavailable">
      <AlertTitle>No preferred-return ledger for this vehicle</AlertTitle>
      <AlertDescription>
        {message} The ledger is kept for a distributable-cash waterfall, where the preferred return accrues on unreturned
        capital and any shortfall is carried forward.
      </AlertDescription>
    </Alert>
  )
}

export function PrefLedgerTable({ rows, money, initiallyOpen = [] }: {
  rows: PrefLedgerRow[]
  money: (n: number) => string
  /** Row indexes whose per-investor lines start open (tests). */
  initiallyOpen?: number[]
}) {
  const [open, setOpen] = useState<Set<number>>(() => new Set(initiallyOpen))
  if (rows.length === 0) return <EmptyState compact>No periods yet. The ledger starts with the first capital contribution.</EmptyState>
  const totals = prefLedgerTotals(rows)
  const toggle = (i: number) => setOpen(s => { const n = new Set(s); if (n.has(i)) n.delete(i); else n.add(i); return n })
  return (
    <div className="overflow-x-auto rounded-card border">
      <table className="w-full text-sm" data-region="pref-ledger">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            <th scope="col" className={`${head} text-left`}>Period</th>
            <th scope="col" className={`${head} text-right`}>Unreturned at start</th>
            <th scope="col" className={`${head} text-right`}>Accrued</th>
            <th scope="col" className={`${head} text-right`}>Brought forward</th>
            <th scope="col" className={`${head} text-right`}>Paid</th>
            <th scope="col" className={`${head} text-right`}>Carried forward</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const isOpen = open.has(i)
            const investors = r.perInvestor ?? []
            return (
              <Fragment key={`${r.periodEnd}-${i}`}>
                <tr className="border-t">
                  <td className="whitespace-nowrap px-3 py-2 tabular-nums">
                    {investors.length > 0 ? (
                      <button type="button" onClick={() => toggle(i)} aria-expanded={isOpen} className="inline-flex items-center gap-1 hover:underline">
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                        {r.periodStart} to {r.periodEnd}
                      </button>
                    ) : `${r.periodStart} to ${r.periodEnd}`}
                  </td>
                  <td className={num}>{money(r.unreturnedStart)}</td>
                  <td className={num}>{money(r.accrued)}</td>
                  <td className={num}>{money(r.broughtForward)}</td>
                  <td className={num}>{money(r.paid)}</td>
                  <td className={num}>{money(r.carriedForward)}</td>
                </tr>
                {isOpen && investors.map(inv => (
                  <tr key={inv.lpEntityId} className="bg-muted/20 text-muted-foreground" data-investor={inv.lpEntityId}>
                    <td className="py-1.5 pl-9 pr-3">{inv.name}</td>
                    <td className={`${num} py-1.5`} title="Unreturned capital after this event">{money(inv.unreturnedEnd)} after</td>
                    <td className={`${num} py-1.5`}>{money(inv.accrued)}</td>
                    <td className="px-3 py-1.5" />
                    <td className={`${num} py-1.5`}>{money(inv.paid)}</td>
                    <td className={`${num} py-1.5`}>{money(inv.carriedForward)}</td>
                  </tr>
                ))}
              </Fragment>
            )
          })}
        </tbody>
        <tfoot className="border-t bg-muted/30 font-medium">
          <tr>
            <td className="px-3 py-2">Total</td>
            <td className="px-3 py-2" />
            <td className={num} data-total="accrued">{money(totals.accrued)}</td>
            <td className="px-3 py-2" />
            <td className={num} data-total="paid">{money(totals.paid)}</td>
            <td className={num} data-total="carried-forward" title="Closing balance: the last period's">{money(totals.carriedForward)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
