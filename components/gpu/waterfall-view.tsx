'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useVehicle } from '@/components/accounting-vehicle'
import { useCanRead, useCanWrite } from '@/components/access-context'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { MANCO_KIND } from '@/lib/vehicle-kinds'
import { ShellSection } from './parts'
import { PositionTiles } from './waterfall-position'
import { TermsCard } from './waterfall-terms-card'
import { PrefLedgerTable, PrefLedgerUnavailable } from './pref-ledger-table'
import { ProposeDistributionDialog } from './propose-distribution'
import { DistributionHistory } from './distribution-history'
import { FeeTermsDialog } from './fee-terms-dialog'
import { TermsAction } from './waterfall-terms-dialog'
import {
  CADENCES, historyScope, positionFromLedger, send, vehicleFetcher, waterfallPaths,
  type Cadence, type FeeTermsReply, type HistoryRow, type PrefLedgerRow, type TermsLoad, type WaterfallTermsReply,
} from './waterfall-api'

export { profitShare, profitShareTotals, historyScope, HISTORY_CAP } from './waterfall-api'
export type { HistoryRow } from './waterfall-api'

// ── GPU fleet (P5) ── Waterfall & distributions on a GPU SPV, on the distributable-cash waterfall:
// the preferred return accrues on unreturned capital and a shortfall is carried forward, then
// capital comes back, then the profit split. Investors' capital is `lp_capital` (the page's gate);
// the terms and the manager's share are `gp_economics`, so they render only for a caller who holds it.
//
// The manager's profit share is shown as PAID, per distribution and in total (Karl's Q8): what has
// settled against the carry lines, beside what was declared. There is no accrued or hypothetical
// figure on this page, and there must not be one.
//
// The position tiles are derived from the pref-ledger rows (lifetime) and the history (capped at
// the distributions shown): `investorPosition` needs each investor's dated contributions, which no
// route this page reads returns.

type Load<T> = { state: 'loading' } | { state: 'ok'; data: T } | { state: 'error'; error: string; status: number }

export function WaterfallView({ vehicle }: { vehicle: string; vehicleId: string | null }) {
  const currency = useCurrency()
  const money = useCallback((n: number) => formatCurrencyFull(n, currency), [currency])
  const seesTerms = useCanRead('gp_economics')
  const readsAccounting = useCanRead('accounting')
  const writesAccounting = useCanWrite('accounting')
  const canDeclare = useCanWrite('lp_capital')
  const { vehicles } = useVehicle()
  const fetcher = useMemo(() => vehicleFetcher(vehicle), [vehicle])

  const [history, setHistory] = useState<Load<HistoryRow[]>>({ state: 'loading' })
  const [ledger, setLedger] = useState<Load<PrefLedgerRow[]>>({ state: 'loading' })
  const [terms, setTerms] = useState<TermsLoad>({ state: 'loading' })
  const [fee, setFee] = useState<FeeTermsReply['terms'] | undefined>(undefined)
  const [cadence, setCadence] = useState<Cadence | null>(null)
  const [cadenceMsg, setCadenceMsg] = useState<string | null>(null)
  const [savingCadence, setSavingCadence] = useState(false)
  const [termsError, setTermsError] = useState<string | null>(null)
  const [termsVersion, setTermsVersion] = useState(0)
  // The reserve the next proposal opens with: the newest declared distribution's (the history's
  // first row, the same `reserve_amount` the preview reports as `lastReserve`), until a preview says.
  const [previewedReserve, setPreviewedReserve] = useState<number | null | undefined>(undefined)

  // Bumped after a declaration: the history and the ledger are read again.
  const [booksVersion, setBooksVersion] = useState(0)
  useEffect(() => {
    let cancelled = false
    void Promise.all([
      send<HistoryRow[]>(fetcher, waterfallPaths.distributions),
      send<PrefLedgerRow[]>(fetcher, waterfallPaths.prefLedger),
    ]).then(([h, l]) => {
      if (cancelled) return
      setHistory(h.ok ? { state: 'ok', data: Array.isArray(h.data) ? h.data : [] } : { state: 'error', error: h.error, status: h.status })
      setLedger(l.ok ? { state: 'ok', data: Array.isArray(l.data) ? l.data : [] } : { state: 'error', error: l.error, status: l.status })
    })
    return () => { cancelled = true }
  }, [fetcher, booksVersion])

  useEffect(() => {
    if (!seesTerms) return
    let cancelled = false
    void (async () => {
      const [w, f, s] = await Promise.all([
        send<WaterfallTermsReply>(fetcher, waterfallPaths.waterfallTerms),
        readsAccounting ? send<FeeTermsReply>(fetcher, waterfallPaths.feeTerms) : null,
        readsAccounting ? send<{ distributionCadence?: string }>(fetcher, waterfallPaths.vehicleSettings) : null,
      ])
      if (cancelled) return
      setTerms(w.ok ? { state: 'ok', data: w.data } : { state: 'error', error: w.error })
      setTermsError(f && !f.ok ? f.error : null)
      setFee(f?.ok ? f.data.terms : undefined)
      const c = s?.ok ? s.data.distributionCadence : undefined
      setCadence(c && (CADENCES as readonly string[]).includes(c) ? (c as Cadence) : null)
    })()
    return () => { cancelled = true }
  }, [fetcher, seesTerms, readsAccounting, termsVersion])

  async function changeCadence(next: Cadence) {
    setSavingCadence(true); setCadenceMsg(null)
    const r = await send(fetcher, waterfallPaths.vehicleSettings, 'PATCH', { distributionCadence: next })
    setSavingCadence(false)
    if (r.ok) setCadence(next)
    else setCadenceMsg(r.error)
  }

  const rows = history.state === 'ok' ? history.data : null
  const ledgerRows = ledger.state === 'ok' ? ledger.data : null
  const position = rows && ledgerRows ? positionFromLedger(ledgerRows, rows) : null
  const lastReserve = previewedReserve !== undefined ? previewedReserve : (rows?.[0]?.reserve ?? null)
  const positionWhy = ledger.state === 'loading' || history.state === 'loading'
    ? 'Loading'
    : ledger.state === 'error' ? 'Needs the pref ledger' : history.state === 'error' ? 'Needs the distributions'
    : position == null ? 'The pref ledger has no per-investor lines' : undefined

  const spinner = <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>

  return (
    <div className="space-y-4">
      <PositionTiles position={position} money={money} scopeCaption={rows ? historyScope(rows.length).caption : undefined} unavailable={positionWhy} />

      {seesTerms && (
        <div className="space-y-2">
          <TermsCard
            waterfall={terms.state === 'ok' ? terms.data : null}
            waterfallError={terms.state === 'error' ? terms.error : undefined}
            waterfallLoading={terms.state === 'loading'}
            fee={fee}
            cadence={{ value: cadence, canEdit: writesAccounting, saving: savingCadence, onChange: c => { void changeCadence(c) } }}
            payeeName={id => vehicles.find(v => v.id === id)?.name ?? null}
            termsAction={<TermsAction fetcher={fetcher} load={terms} onSaved={() => { setTermsVersion(n => n + 1); setBooksVersion(n => n + 1) }} />}
            feeAction={writesAccounting && fee !== undefined ? (
              <FeeTermsDialog
                fetcher={fetcher}
                terms={fee}
                mancos={vehicles.filter(v => v.kind === MANCO_KIND && v.id).map(v => ({ id: v.id!, name: v.name }))}
                onSaved={() => setTermsVersion(n => n + 1)}
              />
            ) : undefined}
          />
          {(termsError || cadenceMsg) && <p className="text-sm text-destructive">{cadenceMsg ?? termsError}</p>}
        </div>
      )}

      <ShellSection title="Preferred return ledger" description="Accrued on unreturned capital each period, paid from distributions, and any shortfall carried forward.">
        {ledger.state === 'loading' ? spinner
          : ledger.state === 'error' ? (ledger.status === 400 ? <PrefLedgerUnavailable message={ledger.error} /> : <p className="text-sm text-destructive">{ledger.error}</p>)
          : <PrefLedgerTable rows={ledger.data} money={money} />}
      </ShellSection>

      <ShellSection
        title="Distributions"
        description="Every distribution declared for this vehicle, and what each tier took."
        action={(
          <ProposeDistributionDialog
            fetcher={fetcher}
            lastReserve={lastReserve}
            seesCarry={seesTerms}
            allowed={canDeclare}
            money={money}
            onPreviewed={setPreviewedReserve}
            onDeclared={() => { setPreviewedReserve(undefined); setBooksVersion(n => n + 1) }}
          />
        )}
      >
        {history.state === 'loading' ? spinner
          : history.state === 'error' ? <p className="text-sm text-destructive">{history.error}</p>
          : <DistributionHistory rows={history.data} seesCarry={seesTerms} money={money} />}
      </ShellSection>
    </div>
  )
}
