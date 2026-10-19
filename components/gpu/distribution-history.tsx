'use client'

import { Fragment, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { Metric } from '@/components/ui/metric'
import { EmptyState } from '@/components/ui/empty-state'
import { HISTORY_CAP, historyScope, profitShare, profitShareTotals, type HistoryRow } from './waterfall-api'

// ── GPU fleet (P5) ── Every distribution declared, newest first, with what each tier took. The
// manager's profit share is shown as PAID (what has settled against the carry lines) beside what
// was declared (Karl, Q8); the manager's columns and figures need gp_economics.

const STATUS_LABEL: Record<HistoryRow['status'], string> = { open: 'Unpaid', partial: 'Part paid', settled: 'Paid' }
const SPLIT_LABEL: Record<HistoryRow['splitMethod'], string> = { waterfall: 'Waterfall', pro_rata: 'Pro-rata by capital', manual: 'Manual split' }

/** What each tier of one distribution took, as frozen on the register when it was declared. */
export function TierBreakdown({ row, seesCarry, money }: { row: HistoryRow; seesCarry: boolean; money: (n: number) => string }) {
  const t = row.tiers
  if (!t) return <p className="text-sm text-muted-foreground">{SPLIT_LABEL[row.splitMethod]}: not split through the waterfall, so there are no tiers.</p>
  const lines: [string, number, string][] = [
    ...((t.contingencyReturn ?? 0) > 0 ? [['Return of unspent contingency', t.contingencyReturn!, 'contingency'] as [string, number, string]] : []),
    ['Preferred return', t.preferred, 'preferred'],
    ['Return of capital', t.returnOfCapital, 'return-of-capital'],
    ['Profit to investors', t.profitToLP, 'profit-to-investors'],
    ...(seesCarry ? [
      ['Manager profit share', t.carry, 'manager-profit-share'] as [string, number, string],
      ...(t.cash ? [
        ['Manager share of return of capital', t.cash.managerRocShare, 'manager-roc-share'] as [string, number, string],
        ['Pref carried forward', t.cash.prefCarriedForward, 'pref-carried-forward'] as [string, number, string],
        ['Unreturned capital after', t.cash.unreturnedAfter, 'unreturned-after'] as [string, number, string],
      ] : []),
    ] : []),
  ]
  return (
    <dl className="grid max-w-xl gap-x-6 text-sm sm:grid-cols-2" data-breakdown={row.distributionId}>
      {lines.map(([label, n, key]) => (
        <div key={key} className="flex items-baseline justify-between gap-3 py-0.5" data-tier={key}>
          <dt className="text-muted-foreground">{label}</dt>
          <dd className="tabular-nums">{money(n)}</dd>
        </div>
      ))}
    </dl>
  )
}

export function DistributionHistory({ rows, seesCarry, money, initiallyOpen = [] }: {
  rows: HistoryRow[]
  seesCarry: boolean
  money: (n: number) => string
  /** Distribution ids whose breakdown starts open (tests). */
  initiallyOpen?: string[]
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set(initiallyOpen))
  if (rows.length === 0) return <EmptyState compact>No distributions declared yet.</EmptyState>
  const toggle = (id: string) => setOpen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  const scope = historyScope(rows.length)
  const totals = profitShareTotals(rows)
  const columns = 6 + (seesCarry ? 3 : 0)
  return (
    <div className="space-y-3">
      {seesCarry && (
        <div className="grid grid-cols-2 gap-3">
          <Metric label="Profit share paid" value={money(totals.paid)} sub={scope.caption} />
          <Metric label="Profit share declared" value={money(totals.declared)} sub={scope.caption} />
        </div>
      )}
      {scope.truncated && (
        <p className="text-sm text-muted-foreground">
          Only the newest {HISTORY_CAP} distributions are shown; older ones are not included in these totals.
        </p>
      )}
      <div className="overflow-x-auto rounded-card border">
        <table className="w-full text-sm" data-region="history">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 text-left font-medium">Date</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">Description</th>
              <th scope="col" className="px-3 py-2 text-left font-medium">Status</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Reserve</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">To investors</th>
              {seesCarry && <th scope="col" className="px-3 py-2 text-right font-medium">Profit share paid</th>}
              {seesCarry && <th scope="col" className="px-3 py-2 text-right font-medium">Profit share declared</th>}
              {seesCarry && <th scope="col" className="px-3 py-2 text-right font-medium">Total</th>}
              <th scope="col" className="px-3 py-2"><span className="sr-only">Tiers</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map(d => {
              const isOpen = open.has(d.distributionId)
              const share = profitShare(d)
              return (
                <Fragment key={d.distributionId}>
                  <tr className="border-t" data-distribution={d.distributionId}>
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{d.date}</td>
                    <td className="px-3 py-2 text-muted-foreground">{d.description ?? '—'}</td>
                    <td className="px-3 py-2 text-muted-foreground">{STATUS_LABEL[d.status] ?? d.status}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{d.reserve == null ? '—' : money(d.reserve)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(d.lpTotal)}</td>
                    {seesCarry && <td className="px-3 py-2 text-right tabular-nums" data-figure="paid">{money(share.paid)}</td>}
                    {seesCarry && <td className="px-3 py-2 text-right tabular-nums" data-figure="declared">{money(share.declared)}</td>}
                    {seesCarry && <td className="px-3 py-2 text-right tabular-nums">{money(d.total)}</td>}
                    <td className="px-3 py-2 text-right">
                      <button type="button" onClick={() => toggle(d.distributionId)} aria-expanded={isOpen}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
                        {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}Tiers
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-muted/20">
                      <td colSpan={columns} className="px-3 py-2"><TierBreakdown row={d} seesCarry={seesCarry} money={money} /></td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="text-caption text-muted-foreground">
        The list reads the newest {HISTORY_CAP} register rows, drafts included, and then leaves the drafts out, so a long
        history can be cut short with fewer than {HISTORY_CAP} distributions shown and no note above. The totals cover the
        distributions shown.
      </p>
    </div>
  )
}
