'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { ArrowRight } from 'lucide-react'
import { useVehicle, FundSwitcher } from '@/components/accounting-vehicle'
import { AccountingBody, AccountingPageHeader } from '@/components/accounting-chrome'
import { Metric } from '@/components/ui/metric'
import { useAccess, useCanRead, useIsAdmin } from '@/components/access-context'
import { send, unreturnedCapital, vehicleFetcher, waterfallPaths, type PrefLedgerRow } from '@/components/gpu/waterfall-api'
import { canSee } from '@/components/app-sidebar'
import { ACCOUNTING_SECTIONS, type AccountingSection } from '@/lib/accounting/nav'
import type { Domain } from '@/lib/access/domains'
import type { FeatureKey } from '@/lib/types/features'
import type { AccessLevel } from '@/lib/access/effective'
import { VEHICLE_KIND_LABELS } from '@/lib/vehicle-kinds'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { browserFetch, listVehicleAssets } from '@/components/gpu/fleet-api'
import { baseCaseReturns, formatReportValue, getVehicleScenarios } from '@/components/gpu/scenarios-api'
import { getVehicleKpis } from '@/components/gpu/revenue-api'
import { LtmTiles, lastCompleteMonth, ltmCaption } from '@/components/gpu/fleet-kpis'
import type { Kpi } from '@/lib/gpu/kpis'
import { fleetTotals, todayIso, valuationDate, type FleetTotals } from '@/components/gpu/fleet-math'

// ── GPU fleet (P5) ── The GPU SPV's lead page, in place of a fund's performance lead: what the fleet
// is worth, what it earned, how busy it was, and how much of the investors' capital is still out.
// Fleet NBV is the register's book value today; the other figures are dashes until the PR that
// computes them lands, and the caption names which one.

// The four GPU sections, straight from the nav, so the quick links and the subnav cannot disagree.
const GPU_SECTIONS = ACCOUNTING_SECTIONS.filter(s => s.showFor?.includes('gpu_spv'))

/**
 * Only the sections this caller can open, by the same `canSee` the subnav uses: Fleet and Revenue
 * need the fleet grant, the waterfall investors' capital under both its switches, Scenarios the
 * books this page already required. A link that bounces to the dashboard is worse than no link.
 */
export function gpuQuickLinks(isAdmin: boolean, access: (domain: Domain, feature?: FeatureKey) => AccessLevel): AccountingSection[] {
  return GPU_SECTIONS.filter(s => canSee({ domain: s.domain, featureKey: s.feature, alsoRequires: s.alsoRequires }, isAdmin, access))
}

export function GpuDetailView({
  vehicle, vehicleId, active,
}: {
  vehicle: string
  vehicleId: string
  active: boolean
}) {
  const { setVehicle } = useVehicle()
  const access = useAccess()
  const isAdmin = useIsAdmin()

  // Pin the section's vehicle context to this URL, exactly as the management company page does. It
  // is what tells the sidebar this entity's KIND, and the subnav's GPU sections are built from it.
  useEffect(() => { setVehicle(vehicle, vehicleId) }, [vehicle, vehicleId, setVehicle])

  const links = gpuQuickLinks(isAdmin, access)

  // ── GPU fleet (P5) ── The primary pitch scenario's investor returns (annual, the headline's),
  // from the Scenarios page's route; a dash until scenarios exist.
  const [base, setBase] = useState<{ returns: ReturnType<typeof baseCaseReturns> } | { error: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    void getVehicleScenarios(browserFetch, vehicle).then(r => {
      if (!cancelled) setBase(r.ok ? { returns: baseCaseReturns(r.data) } : { error: r.error })
    })
    return () => { cancelled = true }
  }, [vehicle])
  const baseSub = !base ? 'Loading…'
    : 'error' in base ? base.error
      : base.returns ? `${base.returns.name}, after fees, annual distributions (pack convention)`
        : 'No scenarios yet: create them on the Scenarios page'
  const currency = useCurrency()

  // The register, for the NBV tile. This page renders only for a caller who can view the fleet
  // (funds/[id]/page.tsx), so the request is theirs to make.
  const [fleet, setFleet] = useState<(FleetTotals & { valuedAsOf: string | null }) | { error: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    void listVehicleAssets(browserFetch, vehicle, todayIso()).then(r => {
      if (!cancelled) setFleet(r.ok ? { ...fleetTotals(r.data.assets), valuedAsOf: valuationDate(r.data.assets) } : { error: r.error })
    })
    return () => { cancelled = true }
  }, [vehicle])

  // Revenue and utilization over the trailing twelve months (GET /api/fleet/kpis, fleet read: this
  // page renders only for a caller who can view the fleet).
  const [ltm, setLtm] = useState<{ kpi: Kpi } | { error: string } | null>(null)
  useEffect(() => {
    let cancelled = false
    void getVehicleKpis(browserFetch, vehicle, lastCompleteMonth()).then(r => {
      if (!cancelled) setLtm(r.ok ? { kpi: r.data.ltm } : { error: r.error })
    })
    return () => { cancelled = true }
  }, [vehicle])

  // Unreturned capital, from the pref ledger the Waterfall page reads (lp_capital): asked for this
  // URL's vehicle by name, not the context's, which this page pins only after its first render.
  const readsCapital = useCanRead('lp_capital')
  const fetcher = useMemo(() => vehicleFetcher(vehicle), [vehicle])
  const [unreturned, setUnreturned] = useState<{ value: number | null; sub: string } | null>(null)
  useEffect(() => {
    if (!readsCapital) return
    let cancelled = false
    void send<PrefLedgerRow[]>(fetcher, waterfallPaths.prefLedger).then(r => {
      if (cancelled) return
      // A refusal is shown in the route's words: a 400 is either other terms or a replay that failed.
      if (!r.ok) { setUnreturned({ value: null, sub: r.error }); return }
      const value = Array.isArray(r.data) ? unreturnedCapital(r.data) : null
      setUnreturned({ value, sub: value == null ? 'The pref ledger has no per-investor lines' : 'From the preferred return ledger' })
    })
    return () => { cancelled = true }
  }, [fetcher, readsCapital])

  return (
    <>
      <AccountingPageHeader
        title={<span className="flex min-w-0 items-center gap-2"><span className="truncate">{vehicle}</span>
          <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-caption font-normal text-muted-foreground">{VEHICLE_KIND_LABELS.gpu_spv}</span>
          {!active && (
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-caption font-normal text-muted-foreground">Inactive</span>
          )}
        </span>}
        titleAttr={vehicle}
        actions={<FundSwitcher />}
      >
        GPU SPV &mdash; the fleet&rsquo;s book value, rental revenue and utilization, and the
        investors&rsquo; capital still to be returned.
      </AccountingPageHeader>

      <AccountingBody>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Metric
              label="Fleet NBV"
              value={fleet && !('error' in fleet) ? formatCurrencyFull(fleet.nbvBook, currency) : '—'}
              sub={!fleet ? 'Loading…' : 'error' in fleet ? fleet.error
                : `${fleet.gpus.toLocaleString()} GPUs on ${fleet.assets} ${fleet.assets === 1 ? 'server' : 'servers'}, ${fleet.inService} in service`
                  + (fleet.planned > 0 ? `; ${formatCurrencyFull(fleet.planned, currency)} not on the books yet` : '')
                  + (fleet.valuedAsOf ? `. Valued as of ${fleet.valuedAsOf}` : '')}
            />
            <LtmTiles ltm={ltm && 'kpi' in ltm ? ltm.kpi : null} error={ltm && 'error' in ltm ? ltm.error : null} base={ltmCaption(lastCompleteMonth())} />
            <Metric
              label="Unreturned capital"
              value={unreturned?.value != null ? formatCurrencyFull(unreturned.value, currency) : '—'}
              sub={!readsCapital ? 'Needs access to investors\u2019 capital' : unreturned?.sub ?? 'Loading'}
            />
            <Metric
              label="Base case investor IRR"
              value={base && 'returns' in base && base.returns ? formatReportValue(base.returns.irr, 'pct', () => '') : '—'}
              sub={baseSub}
              data-base-irr
            />
            <Metric
              label="Base case investor multiple"
              value={base && 'returns' in base && base.returns ? formatReportValue(base.returns.multiple, 'multiple', () => '') : '—'}
              sub={baseSub}
              data-base-multiple
            />
          </div>

          {links.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {links.map(s => {
                const Icon = s.icon
                return (
                  <Link
                    key={s.href}
                    href={`/funds/${vehicleId}/${s.href.slice('/funds/'.length)}`}
                    className="group rounded-card border bg-card p-4 shadow-sm transition-colors hover:bg-muted/30 dark:shadow-none"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex items-center gap-2 font-medium group-hover:underline">
                        <Icon className="h-4 w-4 text-muted-foreground" />{s.label}
                      </span>
                      <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                    </div>
                    <p className="mt-1.5 text-xs text-muted-foreground">{s.desc}</p>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </AccountingBody>
    </>
  )
}
