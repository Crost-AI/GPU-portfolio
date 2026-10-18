'use client'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState } from '@/components/ui/empty-state'
import { HeaderTable, PendingAction, ShellSection } from './parts'

// ── GPU fleet (P5) ── Revenue & payouts. Marketplace figures are entered by hand, one row per asset
// per period, or pasted as CSV into the same rows (Karl's Q1: no marketplace integration yet). This
// is the finished layout for P5-4; every control is disabled and nothing is posted.

const CSV_COLUMNS = 'asset, period_start, period_end, rented_hours, utilization_pct, gross, fee, net, downtime_hours, note'
const PENDING = 'Entry opens with the operations ledger (P5-4).'

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-caption text-muted-foreground">{hint}</p>}
    </div>
  )
}

export function RevenueView(_props: { vehicle: string; vehicleId: string | null }) {
  return (
    <div className="space-y-4">
      <ShellSection
        title="Enter a period"
        description="One row per asset per period. Enter rented GPU-hours or utilization; the other is worked out from the asset's GPU count."
      >
        {/* A disabled fieldset disables every control inside it, so nothing here can be submitted. */}
        <fieldset disabled className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field id="rev-asset" label="Asset">
              <select id="rev-asset" className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm disabled:cursor-not-allowed disabled:opacity-50">
                <option>No in-service assets</option>
              </select>
            </Field>
            <Field id="rev-start" label="Period start"><Input id="rev-start" type="date" /></Field>
            <Field id="rev-end" label="Period end" hint="Defaults to the calendar month."><Input id="rev-end" type="date" /></Field>
            <Field id="rev-note" label="Note"><Input id="rev-note" /></Field>
            <Field id="rev-hours" label="Rented GPU-hours"><Input id="rev-hours" inputMode="decimal" className="text-right tabular-nums" /></Field>
            <Field id="rev-util" label="Utilization %" hint="Or GPU-hours; one of the two."><Input id="rev-util" inputMode="decimal" className="text-right tabular-nums" /></Field>
            <Field id="rev-downtime" label="Downtime GPU-hours" hint="Feeds the uptime figure."><Input id="rev-downtime" inputMode="decimal" className="text-right tabular-nums" /></Field>
            <div className="hidden lg:block" />
            <Field id="rev-gross" label="Gross revenue"><Input id="rev-gross" inputMode="decimal" className="text-right tabular-nums" /></Field>
            <Field id="rev-fee" label="Marketplace fee" hint="Defaults to the account's fee rate."><Input id="rev-fee" inputMode="decimal" className="text-right tabular-nums" /></Field>
            <Field id="rev-net" label="Net payout" hint="Gross less fee, to the cent."><Input id="rev-net" inputMode="decimal" className="text-right tabular-nums" /></Field>
          </div>

          <Field id="rev-csv" label="Or paste CSV" hint={`Columns, in this order (header row optional): ${CSV_COLUMNS}. The asset matches on name or listing reference.`}>
            <Textarea id="rev-csv" rows={4} className="font-mono" placeholder={CSV_COLUMNS} />
          </Field>
        </fieldset>
        <div className="mt-4 flex justify-end">
          <PendingAction label="Stage entries" hint={PENDING} />
        </div>
      </ShellSection>

      <ShellSection title="Entered periods" description="Staged rows wait for review; posting books revenue and fees to the ledger.">
        <HeaderTable columns={[
          { label: 'Asset' }, { label: 'Period' }, { label: 'GPU-hours', align: 'right' }, { label: 'Utilization', align: 'right' },
          { label: 'Gross', align: 'right' }, { label: 'Fee', align: 'right' }, { label: 'Net', align: 'right' },
          { label: 'Downtime', align: 'right' }, { label: 'Status' },
        ]}>
          No periods entered yet.
        </HeaderTable>
      </ShellSection>

      <ShellSection title="Payouts & receivable" description="Marketplace payouts, matched to bank deposits, against the net revenue still owed.">
        <EmptyState compact>No payouts recorded yet. They appear here once periods are posted.</EmptyState>
      </ShellSection>
    </div>
  )
}
