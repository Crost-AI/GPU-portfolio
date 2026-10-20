'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { Field, FormDialog, selectCls } from './fleet-ui'
import { BUSY_STATUSES, PAYOUT_STATUS_LABEL, payoutBody, type PayoutView, type ReceivableTieOut } from './revenue-api'
import { OPS_WRITE_HINT } from './revenue-earnings'

// ── GPU fleet (P5) ── Payouts and the marketplace receivable. Posting a period books its net to
// 1150; a payout the marketplace sends is recorded here and matched to the bank deposit that
// brought it in (Dr 1000 / Cr 1150). The tie-out says whether 1150 holds what that implies.

export const MATCH_HINT = 'Matching a payout books it to the ledger, so it needs write access to Accounting as well as the GPU fleet.'

/** The matching picker's state for one payout row: which candidate, if any, is chosen. */
export function PayoutsTable({ payouts, money, canMatch, choice, onChoose, matching, onMatch }: {
  payouts: PayoutView[]
  money: (n: number) => string
  canMatch: boolean
  choice: Record<string, string>
  onChoose: (payoutId: string, txnId: string) => void
  matching: string | null
  onMatch: (payoutId: string) => void
}) {
  if (payouts.length === 0) return <EmptyState compact>No payouts recorded yet. Record each marketplace payout as it is announced.</EmptyState>
  return (
    <div className="overflow-x-auto rounded-card border">
      <table className="w-full text-sm" data-region="payouts">
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>
            {['Date', 'Amount', 'Reference', 'Status', 'Bank deposit'].map((h, i) => (
              <th key={h} scope="col" className={cn('whitespace-nowrap px-3 py-2 font-medium', i === 1 ? 'text-right' : 'text-left')}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {payouts.map(p => {
            const busy = BUSY_STATUSES.includes(p.status) || matching === p.id
            return (
              <tr key={p.id} className="border-t" data-payout={p.id}>
                <td className="whitespace-nowrap px-3 py-2 tabular-nums">{p.payoutDate}</td>
                <td className="px-3 py-2 text-right tabular-nums">{money(p.amount)}</td>
                <td className="px-3 py-2 text-muted-foreground">{p.reference ?? '—'}{p.note && <p className="text-caption">{p.note}</p>}</td>
                <td className="px-3 py-2">
                  <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-caption font-medium',
                    p.status === 'matched' ? 'bg-success-subtle text-success' : p.status === 'expected' ? 'bg-info-subtle text-info' : 'bg-muted text-muted-foreground')}
                    data-status={p.status}>
                    {busy && <Loader2 className="h-3 w-3 animate-spin" />}{PAYOUT_STATUS_LABEL[p.status] ?? p.status}
                  </span>
                </td>
                <td className="px-3 py-2">
                  {p.status !== 'expected' ? (
                    <span className="text-muted-foreground">{p.bankTransactionId ? 'Matched to a bank deposit' : '—'}</span>
                  ) : p.candidates.length === 0 ? (
                    <span className="text-muted-foreground">No bank deposit of this amount within the window yet.</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <select aria-label={`Bank deposit for the payout of ${p.payoutDate}`} className={cn(selectCls, 'h-8 w-64')}
                        value={choice[p.id] ?? ''} onChange={e => onChoose(p.id, e.target.value)} disabled={!canMatch || busy}>
                        <option value="">Choose a deposit…</option>
                        {p.candidates.map(t => (
                          <option key={t.id} value={t.id}>{t.txnDate} · {money(t.amount)}{t.description ? ` · ${t.description}` : ''}</option>
                        ))}
                      </select>
                      <Button type="button" size="sm" variant="outline" data-action="match" disabled={!canMatch || busy || !choice[p.id]}
                        title={canMatch ? undefined : MATCH_HINT} onClick={() => onMatch(p.id)}>
                        {matching === p.id && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Match
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** 1150 against what posting and matching imply. A difference is what the close check flags. */
export function TieOutCard({ tie, money }: { tie: ReceivableTieOut; money: (n: number) => string }) {
  const off = Math.round(tie.difference * 100) !== 0
  const row = (label: string, n: number, key: string, strong = false) => (
    <div className="flex items-baseline justify-between gap-3 border-b py-1.5 last:border-0" data-tie={key}>
      <dt className={strong ? 'font-medium' : 'text-muted-foreground'}>{label}</dt>
      <dd className={cn('tabular-nums', strong && 'font-medium')}>{money(n)}</dd>
    </div>
  )
  return (
    <div className="rounded-card border p-4" data-region="tie-out">
      <h3 className="text-base font-semibold">Marketplace receivable (1150)</h3>
      <p className="text-caption text-muted-foreground">As of {tie.asOf}</p>
      <dl className="mt-2 text-sm">
        {row('Posted net revenue', tie.postedNet, 'posted-net')}
        {row('Less payouts matched', tie.matchedPayouts, 'matched')}
        {row('Expected in 1150', tie.expected, 'expected', true)}
        {row('Ledger 1150', tie.ledger1150, 'ledger')}
        <div className="flex items-baseline justify-between gap-3 py-1.5" data-tie="difference">
          <dt className="font-medium">Difference</dt>
          <dd className={cn('tabular-nums font-medium', off ? 'rounded-md bg-warning-subtle px-1.5 text-warning' : 'text-success')} data-off={off || undefined}>
            {money(tie.difference)}
          </dd>
        </div>
      </dl>
      <p className="mt-2 text-caption text-muted-foreground">
        {off
          ? 'Something reached 1150 outside posting and payout matching, or the reverse. The close check flags this until it ties out.'
          : 'Ties out: 1150 holds exactly the posted net not yet paid out. The close checks this.'}
      </p>
    </div>
  )
}

/** Record an announced payout, to be matched to its bank deposit when it lands. */
export function RecordPayoutDialog({ open, onOpenChange, onRecord }: {
  open: boolean
  onOpenChange: (o: boolean) => void
  onRecord: (body: { date: string; amount: number; reference?: string; note?: string }) => Promise<string | null>
}) {
  const [form, setForm] = useState({ date: '', amount: '', reference: '', note: '' })
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }))
  return (
    <FormDialog open={open} onOpenChange={o => { onOpenChange(o); if (!o) setForm({ date: '', amount: '', reference: '', note: '' }) }}
      title="Record a payout" description="A payout the marketplace has announced. Match it to the bank deposit once it lands."
      submitLabel="Record payout"
      onSubmit={async () => {
        const req = payoutBody(form)
        if (!req.ok) return req.error
        return onRecord(req.body)
      }}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field id="payout-date" label="Payout date"><Input id="payout-date" type="date" value={form.date} onChange={set('date')} className="tabular-nums" /></Field>
        <Field id="payout-amount" label="Amount"><Input id="payout-amount" inputMode="decimal" value={form.amount} onChange={set('amount')} className="text-right tabular-nums" /></Field>
        <Field id="payout-ref" label="Reference" hint="The marketplace's payout id, if it gives one."><Input id="payout-ref" value={form.reference} onChange={set('reference')} /></Field>
        <Field id="payout-note" label="Note"><Input id="payout-note" value={form.note} onChange={set('note')} /></Field>
      </div>
    </FormDialog>
  )
}

/**
 * The auto-post setting arrives with P3 PR B (#98: GET/PATCH /api/fleet/ops/settings). Until that is on
 * main the toggle is shown off and disabled, with what it will do; P5-4b wires it.
 */
export function AutoPostPlaceholder() {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed px-3 py-2" data-placeholder="auto-post">
      <Switch id="auto-post" checked={false} disabled aria-describedby="auto-post-caption" />
      <div>
        <label htmlFor="auto-post" className="text-sm text-muted-foreground">Post payout matches automatically from the bank auto-match run</label>
        <p id="auto-post-caption" className="text-caption text-muted-foreground">
          Not available yet: the setting arrives with the operations settings, defaulting to propose rather than post. Today the
          bank page&rsquo;s auto-match run books a payout&rsquo;s match itself when exactly one expected payout fits a deposit;
          a deposit that fits several is left for you to match here.
        </p>
      </div>
    </div>
  )
}

export { OPS_WRITE_HINT }
