'use client'

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useLedgerFetch } from '@/components/accounting-vehicle'
import { useCanRead } from '@/components/access-context'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/ui/empty-state'
import { Metric } from '@/components/ui/metric'
import { HeaderTable, PendingAction, ShellSection } from './parts'

// ── GPU fleet (P5) ── Waterfall & distributions on a GPU SPV: preferred return on unreturned capital,
// then return of capital, then the profit split. The terms and the manager's share are
// `gp_economics`, so they render only for a caller who holds it.
//
// The manager's profit share is shown as PAID, per distribution (Karl's Q8): what has settled
// against the carry lines, beside what was declared. There is no accrued or hypothetical figure on
// this page, and there must not be one.
//
// The history is the one region with data today: the existing distributions route, as it is. The
// rest is the layout P5-3 wires to the pref ledger and the distributable-cash preview.

/** The fields of GET /api/accounting/distributions this page reads (lib/accounting/distributions.ts). */
export interface HistoryRow {
  distributionId: string
  date: string
  description: string | null
  total: number
  lpTotal: number
  carryTotal: number
  status: 'open' | 'partial' | 'settled'
  lines: { role: 'lp' | 'carry'; amount: number; settled: number }[]
}

const cents = (n: number) => Math.round(n * 100) / 100

/**
 * The manager's profit share on one distribution: `declared` is what the carry lines say, `paid`
 * what has settled against them. A declared-but-unwired distribution is paid 0 — `carryTotal` is
 * the declared figure and must never be shown as paid.
 */
export function profitShare(row: Pick<HistoryRow, 'carryTotal' | 'lines'>): { paid: number; declared: number } {
  const carry = (row.lines ?? []).filter(l => l.role === 'carry')
  return { paid: cents(carry.reduce((t, l) => t + (l.settled ?? 0), 0)), declared: row.carryTotal }
}

/** Every distribution's profit share, summed: the cumulative tiles. */
export function profitShareTotals(rows: Pick<HistoryRow, 'carryTotal' | 'lines'>[]): { paid: number; declared: number } {
  return rows.reduce((t, r) => {
    const p = profitShare(r)
    return { paid: cents(t.paid + p.paid), declared: cents(t.declared + p.declared) }
  }, { paid: 0, declared: 0 })
}

/**
 * GET /api/accounting/distributions returns the newest 200 (listDistributions `.limit(200)`), so a
 * sum over the response is a sum over what is shown, never a lifetime figure. The server aggregate
 * arrives with the P2 history in P5-3.
 */
export const HISTORY_CAP = 200

/** The caption under the cumulative tiles: what they sum, and what they leave out. */
export function historyScope(n: number): { caption: string; truncated: boolean } {
  return { caption: `In the ${n} ${n === 1 ? 'distribution' : 'distributions'} shown`, truncated: n >= HISTORY_CAP }
}

const STATUS_LABEL: Record<HistoryRow['status'], string> = { open: 'Unpaid', partial: 'Part paid', settled: 'Paid' }

export function WaterfallView(_props: { vehicle: string; vehicleId: string | null }) {
  const lf = useLedgerFetch()
  const currency = useCurrency()
  const seesTerms = useCanRead('gp_economics')
  const money = (n: number) => formatCurrencyFull(n, currency)

  const [history, setHistory] = useState<HistoryRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    lf('/api/accounting/distributions')
      .then(async r => {
        const body = await r.json().catch(() => null)
        if (!r.ok) throw new Error(body?.error ?? 'Could not load the distributions.')
        return Array.isArray(body) ? (body as HistoryRow[]) : []
      })
      .then(rows => { if (!cancelled) { setHistory(rows); setError(null) } })
      .catch(e => { if (!cancelled) setError((e as Error).message) })
    return () => { cancelled = true }
  }, [lf])

  return (
    <div className="space-y-4">
      {seesTerms && (
        <ShellSection title="Terms" description="How each distribution is split between investors and the manager.">
          <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
            {['Preferred return', 'Preferred return day count', 'Return of capital to investors', 'Manager profit share', 'Distribution cadence'].map(t => (
              <div key={t} className="flex items-baseline justify-between gap-3 border-b py-1.5 last:border-0">
                <dt className="text-muted-foreground">{t}</dt>
                <dd className="tabular-nums text-muted-foreground">&mdash;</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-caption text-muted-foreground">The terms are set here once the waterfall is wired (P5-3).</p>
        </ShellSection>
      )}

      <ShellSection title="Preferred return ledger" description="Accrued on unreturned capital each period, paid from distributions, and any shortfall carried forward.">
        <HeaderTable columns={[
          { label: 'Period' }, { label: 'Unreturned at start', align: 'right' }, { label: 'Pref for period', align: 'right' },
          { label: 'Brought forward', align: 'right' }, { label: 'Paid', align: 'right' }, { label: 'Carried forward', align: 'right' },
        ]}>
          No periods yet. The ledger starts with the first capital contribution.
        </HeaderTable>
      </ShellSection>

      <ShellSection title="Propose a distribution" description="The reserve is held back first; the rest runs through the waterfall.">
        <fieldset disabled className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="wf-available" className="text-xs">Available cash</Label>
            <Input id="wf-available" inputMode="decimal" className="text-right tabular-nums" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-reserve" className="text-xs">Working-capital reserve (required)</Label>
            <Input id="wf-reserve" inputMode="decimal" required className="text-right tabular-nums" />
            <p className="text-caption text-muted-foreground">Pre-filled with the last distribution&rsquo;s reserve.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-contingency" className="text-xs">Return of unspent contingency</Label>
            <Input id="wf-contingency" inputMode="decimal" defaultValue="0" className="text-right tabular-nums" />
            <p className="text-caption text-muted-foreground">Paid to investors as return of capital.</p>
          </div>
        </fieldset>
        <div className="mt-4 flex justify-end">
          <PendingAction label="Preview" hint="Previewing and declaring arrive with the waterfall (P5-3)." />
        </div>
      </ShellSection>

      <ShellSection title="History" description="Every distribution declared for this vehicle.">
        {error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : history === null ? (
          <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : history.length === 0 ? (
          <EmptyState compact>No distributions declared yet.</EmptyState>
        ) : (
          <div className="space-y-3">
          {seesTerms && (() => {
            const totals = profitShareTotals(history)
            const scope = historyScope(history.length)
            return (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-3">
                  <Metric label="Profit share paid" value={money(totals.paid)} sub={scope.caption} />
                  <Metric label="Profit share declared" value={money(totals.declared)} sub={scope.caption} />
                </div>
                {scope.truncated && (
                  <p className="text-sm text-muted-foreground">
                    Only the newest {HISTORY_CAP} distributions are shown; older ones are not included in these totals.
                  </p>
                )}
              </div>
            )
          })()}
          <div className="overflow-x-auto rounded-card border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 text-left font-medium">Date</th>
                  <th scope="col" className="px-3 py-2 text-left font-medium">Description</th>
                  <th scope="col" className="px-3 py-2 text-right font-medium">To investors</th>
                  {seesTerms && <th scope="col" className="px-3 py-2 text-right font-medium">Profit share paid</th>}
                  {seesTerms && <th scope="col" className="px-3 py-2 text-right font-medium">Profit share declared</th>}
                  {seesTerms && <th scope="col" className="px-3 py-2 text-right font-medium">Total</th>}
                  <th scope="col" className="px-3 py-2 text-left font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {history.map(d => (
                  <tr key={d.distributionId} className="border-t">
                    <td className="whitespace-nowrap px-3 py-2 tabular-nums">{d.date}</td>
                    <td className="px-3 py-2 text-muted-foreground">{d.description ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(d.lpTotal)}</td>
                    {seesTerms && <td className="px-3 py-2 text-right tabular-nums">{money(profitShare(d).paid)}</td>}
                    {seesTerms && <td className="px-3 py-2 text-right tabular-nums">{money(profitShare(d).declared)}</td>}
                    {seesTerms && <td className="px-3 py-2 text-right tabular-nums">{money(d.total)}</td>}
                    <td className="px-3 py-2 text-muted-foreground">{STATUS_LABEL[d.status] ?? d.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </div>
        )}
      </ShellSection>
    </div>
  )
}
