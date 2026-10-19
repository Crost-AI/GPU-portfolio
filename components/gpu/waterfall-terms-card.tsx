import Link from 'next/link'
import { ShellSection } from './parts'
import { CADENCES, type Cadence, type FeeTermsReply, type WaterfallTermsReply } from './waterfall-api'

// ── GPU fleet (P5) ── The terms in force: the waterfall's (gp_economics, so the page renders this
// card only for a caller who holds it), the management fee's, and the distribution cadence. A
// summary: the terms are edited on their own surfaces, linked from here.

const KIND_LABEL: Record<string, string> = {
  distributable_cash: 'Distributable cash', european: 'European', american: 'American', straight: 'Straight split', none: 'No profit share',
}

/** The pref day count as the pack names it: `30_360` is European 30/360. */
export function dayCountLabel(v: string | undefined): string {
  if (v === '30_360') return '30E/360'
  if (v === 'act_365') return 'ACT/365'
  return v ?? '—'
}

export const CADENCE_LABEL: Record<Cadence, string> = { monthly: 'Monthly', quarterly: 'Quarterly', annual: 'Annual', ad_hoc: 'Ad hoc' }

const pct = (r: number) => `${Number((r * 100).toFixed(4))}%`

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b py-1.5 last:border-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  )
}

export function TermsCard({ waterfall, fee, cadence, payeeName, feeAction, termsAction }: {
  waterfall: WaterfallTermsReply | null
  /** undefined: the caller cannot read the fee terms (accounting); null: the vehicle has none. */
  fee: FeeTermsReply['terms'] | undefined
  /** `value` null: the vehicle-settings route does not report the cadence. */
  cadence: { value: Cadence | null; canEdit: boolean; saving?: boolean; onChange: (c: Cadence) => void }
  payeeName: (vehicleId: string) => string | null
  /** The Edit fee terms button, for a caller with accounting write. */
  feeAction?: React.ReactNode
  /** The Edit terms button, for a caller who may change the waterfall here; else a link to the terms page. */
  termsAction?: React.ReactNode
}) {
  const t = waterfall?.terms
  const nameOf = (id: string) => waterfall?.candidates.find(c => c.lpEntityId === id)?.name ?? id
  return (
    <ShellSection
      title="Terms"
      description="How each distribution is split between investors and the manager."
      action={termsAction ?? <Link href="/funds/allocation-terms" className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">Edit terms</Link>}
    >
      <div className="grid gap-x-8 gap-y-4 md:grid-cols-2" data-region="terms">
        <dl className="text-sm">
          {t ? (
            <>
              <Row label="Waterfall">{KIND_LABEL[t.kind] ?? t.kind}</Row>
              <Row label="Preferred return">{pct(t.prefRate)} simple, on unreturned capital</Row>
              <Row label="Preferred return day count">{dayCountLabel(t.prefDayCount)}</Row>
              <Row label="Return of capital to investors">{pct(t.rocLpShare ?? 1)}</Row>
              <Row label="Profit split">{pct(1 - t.carryRate)} investors / {pct(t.carryRate)} manager</Row>
              <Row label="Profit share recipients">
                {t.recipients.length ? t.recipients.map(r => `${nameOf(r.lpEntityId)} (${Number(r.pct.toFixed(2))}%)`).join(', ') : 'None named'}
              </Row>
            </>
          ) : (
            <Row label="Waterfall">Not set</Row>
          )}
        </dl>
        <dl className="text-sm">
          {fee === undefined ? (
            <Row label="Management fee">Needs access to Accounting</Row>
          ) : fee === null ? (
            <Row label="Management fee">None set</Row>
          ) : (
            <>
              <Row label="Management fee basis">{fee.basis === 'gross_revenue' ? 'Gross rental revenue' : fee.basis}</Row>
              <Row label="Fee rate">{pct(fee.annualRate)} of revenue</Row>
              <Row label="Fee accrued">{fee.frequency === 'quarterly' ? 'Quarterly' : 'Monthly'}</Row>
              <Row label="Fee payee">{fee.payeeVehicleId ? (payeeName(fee.payeeVehicleId) ?? 'Management company') : 'Due to manager (2100)'}</Row>
              <Row label="Fee in force">{fee.effectiveFrom ?? '—'} to {fee.effectiveTo ?? 'open'}</Row>
            </>
          )}
          {feeAction && <div className="flex justify-end py-1.5">{feeAction}</div>}
          <Row label="Distribution cadence">
            {cadence.value == null ? (
              <span className="text-muted-foreground">Not reported by the vehicle settings yet</span>
            ) : cadence.canEdit ? (
              <select
                aria-label="Distribution cadence"
                value={cadence.value}
                disabled={cadence.saving}
                onChange={e => cadence.onChange(e.target.value as Cadence)}
                className="h-8 rounded-md border border-input bg-background px-2 text-sm"
              >
                {CADENCES.map(c => <option key={c} value={c}>{CADENCE_LABEL[c]}</option>)}
              </select>
            ) : (
              CADENCE_LABEL[cadence.value]
            )}
          </Row>
        </dl>
      </div>
    </ShellSection>
  )
}
