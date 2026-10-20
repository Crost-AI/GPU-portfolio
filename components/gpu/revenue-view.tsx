'use client'

import { useEffect, useMemo, useState } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { useCanWrite } from '@/components/access-context'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { Input } from '@/components/ui/input'
import { ShellSection } from './parts'
import { ErrorAlert, Field, GatedButton } from './fleet-ui'
import { listAssets, type Fetcher } from './fleet-api'
import { todayIso } from './fleet-math'
import { vehicleFetcher } from './waterfall-api'
import { EntryForm } from './revenue-entry'
import { EarningsTable, OPS_WRITE_HINT, ReversalConfirm } from './revenue-earnings'
import { AutoPostPlaceholder, PayoutsTable, RecordPayoutDialog, TieOutCard } from './revenue-payouts'
import {
  entryRowFor, ignoreEarnings, lastTwelveMonths, listEarnings, listPayouts, matchPayout, postEarnings, previousMonth, recordPayout,
  type EarningView, type EntryRow, type NeedsReversal, type PayoutView, type ReceivableTieOut,
} from './revenue-api'

// ── GPU fleet (P5) ── Revenue & payouts for a GPU SPV. Marketplace figures are entered by hand, one
// row per server per period, or pasted as CSV (Karl's Q1: no marketplace integration). Entering
// stages; posting books revenue and needs Accounting write as well as the fleet grant; a payout is
// recorded, then matched to its bank deposit, and the 1150 tie-out says whether the two agree.

type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; error: string }

export function RevenueView({ vehicle }: { vehicle: string; vehicleId: string | null }) {
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)
  const canWriteFleet = useCanWrite('fleet')
  const canBook = useCanWrite('accounting')
  const fetcher: Fetcher = useMemo(() => vehicleFetcher(vehicle), [vehicle])
  const [today] = useState(todayIso)

  const [entryRows, setEntryRows] = useState<Load<EntryRow[]>>({ state: 'loading' })
  const [range, setRange] = useState(() => lastTwelveMonths(today))
  const [earnings, setEarnings] = useState<Load<EarningView[]>>({ state: 'loading' })
  const [payouts, setPayouts] = useState<Load<{ payouts: PayoutView[]; receivable: ReceivableTieOut }>>({ state: 'loading' })
  const [earningsVersion, setEarningsVersion] = useState(0)
  const [payoutsVersion, setPayoutsVersion] = useState(0)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState<'post' | 'ignore' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [reversal, setReversal] = useState<{ ids: string[]; entries: NeedsReversal[]; error: string | null } | null>(null)

  const [choice, setChoice] = useState<Record<string, string>>({})
  const [matching, setMatching] = useState<string | null>(null)
  const [payoutError, setPayoutError] = useState<string | null>(null)
  const [recordOpen, setRecordOpen] = useState(false)

  // The servers to enter for: on the books and running (in service or offline), as of today.
  useEffect(() => {
    let cancelled = false
    void listAssets(fetcher, today).then(r => {
      if (cancelled) return
      setEntryRows(r.ok
        ? { state: 'ok', data: r.data.assets.filter(a => a.status === 'in_service' || a.status === 'offline').map(entryRowFor) }
        : { state: 'error', error: r.error })
    })
    return () => { cancelled = true }
  }, [fetcher, today])

  useEffect(() => {
    let cancelled = false
    void listEarnings(fetcher, range.from, range.to).then(r => {
      if (cancelled) return
      setEarnings(r.ok ? { state: 'ok', data: r.data.rows } : { state: 'error', error: r.error })
      // A row that has moved on (posted, ignored) cannot stay selected.
      if (r.ok) setSelected(s => new Set(r.data.rows.filter(x => s.has(x.id) && (x.status === 'staged' || x.status === 'unmatched')).map(x => x.id)))
    })
    return () => { cancelled = true }
  }, [fetcher, range, earningsVersion])

  useEffect(() => {
    let cancelled = false
    void listPayouts(fetcher).then(r => {
      if (!cancelled) setPayouts(r.ok ? { state: 'ok', data: r.data } : { state: 'error', error: r.error })
    })
    return () => { cancelled = true }
  }, [fetcher, payoutsVersion])

  const reloadEarnings = () => setEarningsVersion(n => n + 1)
  const reloadPayouts = () => setPayoutsVersion(n => n + 1)

  async function post(ids: string[], confirmReversal = false) {
    setBusy('post'); setActionError(null); setNotice(null)
    const r = await postEarnings(fetcher, ids, confirmReversal)
    setBusy(null)
    // Posting is per row: a refusal can come after earlier rows were posted or an old entry was
    // reversed, so the receivable is read again whatever the outcome, not only on success.
    if (!r.ok) {
      // A confirmed re-send that fails says so inside the open confirmation, never hidden behind it.
      if (confirmReversal && reversal) setReversal({ ...reversal, error: r.error })
      else setActionError(r.error)
      reloadEarnings(); reloadPayouts(); return
    }
    if ('needsReversal' in r.data) { setReversal({ ids, entries: r.data.needsReversal, error: null }); return }
    setReversal(null)
    const { posted, reversed } = r.data
    setNotice(`Posted ${posted.length} ${posted.length === 1 ? 'period' : 'periods'}${reversed.length ? `, reversing ${reversed.length} posted ${reversed.length === 1 ? 'entry' : 'entries'} first` : ''}.`)
    setSelected(new Set())
    reloadEarnings(); reloadPayouts()
  }

  async function ignore(ids: string[]) {
    setBusy('ignore'); setActionError(null); setNotice(null)
    const r = await ignoreEarnings(fetcher, ids)
    setBusy(null)
    if (!r.ok) { setActionError(r.error); reloadEarnings(); return }
    setNotice(`Ignored ${r.data.ignored.length} ${r.data.ignored.length === 1 ? 'row' : 'rows'}.`)
    setSelected(new Set())
    reloadEarnings()
  }

  async function match(payoutId: string, txnId: string) {
    if (!txnId) return
    setMatching(payoutId); setPayoutError(null)
    const r = await matchPayout(fetcher, payoutId, txnId)
    setMatching(null)
    if (!r.ok) setPayoutError(r.error)
    reloadPayouts()
  }

  const spinner = <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
  const selectedIds = [...selected]

  return (
    <div className="space-y-4">
      <ShellSection
        title="Enter a period"
        description="One row per server per period. Enter rented GPU-hours or utilization; the other is worked out from the server's GPU count. Entries are staged, not posted."
      >
        {!canWriteFleet && <p className="mb-3 text-caption text-muted-foreground">{OPS_WRITE_HINT}</p>}
        {entryRows.state === 'loading' ? spinner
          : entryRows.state === 'error' ? <ErrorAlert>Could not load the servers to enter for: {entryRows.error}</ErrorAlert>
          : <EntryForm fetcher={fetcher} initialRows={entryRows.data} initialPeriod={previousMonth(today)} canWrite={canWriteFleet} onStaged={reloadEarnings} />}
      </ShellSection>

      <ShellSection
        title="Entered periods"
        description="Staged rows wait for review; posting books revenue and fees to the ledger."
        action={(
          <div className="flex items-end gap-2">
            <Field id="earnings-from" label="Periods ending from">
              <Input id="earnings-from" type="date" value={range.from} onChange={e => e.target.value && setRange(r => ({ ...r, from: e.target.value }))} className="h-9 w-40 tabular-nums" />
            </Field>
            <Field id="earnings-to" label="to">
              <Input id="earnings-to" type="date" value={range.to} onChange={e => e.target.value && setRange(r => ({ ...r, to: e.target.value }))} className="h-9 w-40 tabular-nums" />
            </Field>
          </div>
        )}
      >
        {actionError && <div className="mb-3"><ErrorAlert>{actionError}</ErrorAlert></div>}
        {notice && <p role="status" className="mb-3 text-sm text-success">{notice}</p>}
        {earnings.state === 'loading' ? spinner
          : earnings.state === 'error' ? <ErrorAlert>{earnings.error}</ErrorAlert>
          : (
            <EarningsTable
              rows={earnings.data} money={money} selected={selected}
              onToggle={id => setSelected(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })}
              canWriteFleet={canWriteFleet} canBook={canBook} busy={busy}
              onPost={() => { void post(selectedIds) }}
              onIgnore={() => { void ignore(selectedIds) }}
            />
          )}
      </ShellSection>

      <ShellSection
        title="Payouts & receivable"
        description="Marketplace payouts, matched to bank deposits, against the net revenue still owed."
        action={<GatedButton allowed={canWriteFleet} hint={OPS_WRITE_HINT} onClick={() => setRecordOpen(true)}><Plus className="mr-1 h-4 w-4" />Record payout</GatedButton>}
      >
        {payouts.state === 'loading' ? spinner
          : payouts.state === 'error' ? <ErrorAlert>{payouts.error}</ErrorAlert>
          : (
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="space-y-3 lg:col-span-2">
                {payoutError && <ErrorAlert>{payoutError}</ErrorAlert>}
                <PayoutsTable
                  payouts={payouts.data.payouts} money={money} canMatch={canWriteFleet && canBook}
                  choice={choice} onChoose={(p, t) => setChoice(c => ({ ...c, [p]: t }))}
                  matching={matching} onMatch={(id, txn) => { void match(id, txn) }}
                />
                <p className="text-caption text-muted-foreground">
                  Matching books the deposit against the receivable (Dr 1000 / Cr 1150). The bank page&rsquo;s auto-match run also
                  matches a payout when exactly one fits a deposit, so a payout may show as matched without being matched here.
                </p>
                <AutoPostPlaceholder />
              </div>
              <TieOutCard tie={payouts.data.receivable} money={money} />
            </div>
          )}
      </ShellSection>

      <ReversalConfirm
        open={reversal != null}
        entries={reversal?.entries ?? []}
        rows={earnings.state === 'ok' ? earnings.data : []}
        busy={busy === 'post'}
        error={reversal?.error ?? null}
        money={money}
        onCancel={() => setReversal(null)}
        onConfirm={() => { if (reversal) { setReversal({ ...reversal, error: null }); void post(reversal.ids, true) } }}
      />
      <RecordPayoutDialog
        open={recordOpen}
        onOpenChange={setRecordOpen}
        onRecord={async body => {
          const r = await recordPayout(fetcher, body)
          if (!r.ok) return r.error
          reloadPayouts()
          return null
        }}
      />
    </div>
  )
}
