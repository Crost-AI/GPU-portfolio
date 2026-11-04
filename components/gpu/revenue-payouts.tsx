'use client'

import { useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/components/ui/empty-state'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { ErrorAlert, Field, FormDialog, selectCls } from './fleet-ui'
import { PAYOUT_STATUS_LABEL, payoutBody, suggestedMatches, type PayoutView, type ReceivableTieOut } from './revenue-api'
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
  onMatch: (payoutId: string, txnId: string) => void
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
            const busy = matching === p.id
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
                  {p.status === 'matching' && p.bankTransactionId ? (
                    // A claim left by an attempt that did not finish: matching again to the same deposit resumes it.
                    <div className="space-y-1">
                      <Button type="button" size="sm" variant="outline" data-action="match" disabled={!canMatch || matching === p.id}
                        title={canMatch ? undefined : MATCH_HINT} onClick={() => onMatch(p.id, p.bankTransactionId!)}>
                        {matching === p.id && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Resume match
                      </Button>
                      <p className="text-caption text-muted-foreground" data-caption="resume">
                        The previous attempt to match this payout did not complete. Matching again resumes it; if another request is still working on it, you will be told to try again shortly.
                      </p>
                    </div>
                  ) : p.status !== 'expected' ? (
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
                        title={canMatch ? undefined : MATCH_HINT} onClick={() => onMatch(p.id, choice[p.id])}>
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

export const AUTO_POST_HINT = 'Changing how payouts are booked needs write access to Accounting as well as the GPU fleet.'

/**
 * Whether the bank auto-match run books a payout match itself (GET/PATCH /api/fleet/ops/settings).
 * Off by default: the run proposes, and a person confirms each match below. Turning it on lets the run
 * post to the books, so it needs Accounting write as well as fleet write, as the route does.
 */
export function AutoPostSwitch({ value, error, canWrite, saving, onChange }: {
  /** null while the setting is read. */
  value: boolean | null
  error: string | null
  canWrite: boolean
  saving: boolean
  onChange: (on: boolean) => void
}) {
  return (
    <div className="space-y-1 rounded-lg border px-3 py-2" data-region="auto-post">
      <div className="flex items-start gap-3">
        <Switch id="auto-post" checked={value === true} disabled={value == null || !canWrite || saving}
          onCheckedChange={onChange} aria-describedby="auto-post-caption" title={canWrite ? undefined : AUTO_POST_HINT} />
        <div>
          <label htmlFor="auto-post" className="text-sm">Post payout matches automatically from the bank auto-match run</label>
          <p id="auto-post-caption" className="text-caption text-muted-foreground">
            {value
              ? 'On: the bank page\u2019s auto-match run books a payout\u2019s match itself when exactly one expected payout fits a deposit.'
              : 'Off (the default): the run proposes each match and books nothing; the suggested matches below wait for you to confirm.'}
            {!canWrite && ` ${AUTO_POST_HINT}`}
          </p>
        </div>
      </div>
      {error && <ErrorAlert>{error}</ErrorAlert>}
    </div>
  )
}

/**
 * The single-fit matches the bank auto-match run proposes, as this page can see them (suggestedMatches:
 * a deposit that fits one expected payout and no other). Confirming one posts the match action, the
 * same gate as Match.
 */
export function SuggestedMatches({ payouts, money, canMatch, matching, onConfirm }: {
  payouts: PayoutView[]
  money: (n: number) => string
  canMatch: boolean
  matching: string | null
  onConfirm: (payoutId: string, txnId: string) => void
}) {
  const list = suggestedMatches(payouts)
  return (
    <div className="space-y-2" data-region="suggested-matches">
      <h3 className="text-base font-semibold">Suggested matches</h3>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">No expected payout has a bank deposit that fits it alone right now.</p>
      ) : (
        <ul className="space-y-1.5">
          {list.map(({ payout, txn }) => (
            <li key={payout.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm" data-suggestion={payout.id}>
              <span>
                Payout <span className="tabular-nums">{payout.payoutDate}</span> · <span className="tabular-nums">{money(payout.amount)}</span>
                {payout.reference && <> · {payout.reference}</>}
                <span className="text-muted-foreground"> to the deposit of <span className="tabular-nums">{txn.txnDate}</span>{txn.description ? ` (${txn.description})` : ''}</span>
              </span>
              <Button type="button" size="sm" variant="outline" data-action="confirm-match" disabled={!canMatch || matching === payout.id}
                title={canMatch ? undefined : MATCH_HINT} onClick={() => onConfirm(payout.id, txn.id)}>
                {matching === payout.id && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}Confirm match
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-caption text-muted-foreground">
        Each suggestion is a deposit that fits one expected payout and nothing else, the single fits the bank page&rsquo;s auto-match
        run proposes. A deposit that fits several payouts is left to the Match picker above. The run also leaves to a person a deposit
        that fits a partner&rsquo;s open capital call, which this list cannot see: check the bank page before confirming one that
        might be a partner&rsquo;s wire.
      </p>
    </div>
  )
}

export { OPS_WRITE_HINT }
