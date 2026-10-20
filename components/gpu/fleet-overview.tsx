'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, Loader2, Server } from 'lucide-react'
import { Metric } from '@/components/ui/metric'
import { EmptyState } from '@/components/ui/empty-state'
import { AddVehicleButton } from '@/components/add-vehicle-button'
import { useCanWrite } from '@/components/access-context'
import { useCurrency, formatCurrencyFull } from '@/components/currency-context'
import { browserFetch, listVehicleAssets, mapBounded } from './fleet-api'
import { combineLtm, getVehicleKpis } from './revenue-api'
import { LtmTiles } from './fleet-kpis'
import type { Kpi } from '@/lib/gpu/kpis'
import { ZERO_TOTALS, addTotals, fleetTotals, todayIso, valuationDate, type FleetTotals, type ValuedAsset } from './fleet-math'

// ── GPU fleet (P5) ── The firm-wide fleet: one card per GPU SPV with its GPUs, cost and book value,
// and the totals across them. Each vehicle's register is its own request (a few at a time); one that
// fails says so on its card and is left out of the totals, which then say they are partial.

export interface FleetVehicle { id: string; name: string; active: boolean }

export type Loaded = { assets: ValuedAsset[] } | { error: string }

/**
 * The page as it renders for a set of loaded registers: no fetching, so it can be rendered on its own.
 * Every figure is the server's valuation as of `asOf`, the date the registers were fetched for.
 */
export function FleetOverviewView({ vehicles, loaded, asOf, addButton = null, kpis = {} }: {
  vehicles: FleetVehicle[]
  loaded: Record<string, Loaded>
  asOf: string
  addButton?: React.ReactNode
  /** Each vehicle's trailing-twelve-month KPIs, or why not, as they arrive. */
  kpis?: Record<string, { kpi: Kpi } | { error: string }>
}) {
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)

  const per = new Map(vehicles.map(v => {
    const l = loaded[v.id]
    return [v.id, l && 'assets' in l ? fleetTotals(l.assets) : null]
  }))
  const totals = [...per.values()].reduce<FleetTotals>((t, x) => (x ? addTotals(t, x) : t), ZERO_TOTALS)
  const pending = vehicles.filter(v => !loaded[v.id]).length
  const failed = vehicles.filter(v => { const l = loaded[v.id]; return l && 'error' in l }).length
  const partial = pending > 0 || failed > 0
  const shown = (n: string) => (vehicles.length === 0 ? '—' : n)
  // The date the server valued the loaded registers as of: shown, rather than the date asked for.
  const valuedAsOf = valuationDate(Object.values(loaded).flatMap(l => ('assets' in l ? l.assets : [])), asOf)
  const partialNote = pending > 0 ? 'Loading…' : `Partial: ${failed} ${failed === 1 ? 'vehicle' : 'vehicles'} could not be loaded`

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Metric label="GPU SPVs" value={vehicles.length.toLocaleString()} sub={`${totals.inService} servers in service`} />
        <Metric label="GPUs" value={shown(totals.gpus.toLocaleString())} sub={partial ? partialNote : `${totals.assets} servers`} />
        <Metric
          label="Fleet basis"
          value={shown(money(totals.basis))}
          sub={partial ? partialNote : totals.planned > 0 ? `On the books; ${money(totals.planned)} more planned or unbooked` : 'Hardware and capitalized costs on the books'}
        />
        <Metric label="Fleet NBV" value={shown(money(totals.nbvBook))} sub={partial ? partialNote : `Book, as of ${valuedAsOf}; tax book ${money(totals.nbvTax)}`} data-valuation-as-of={valuedAsOf ?? undefined} />
        {(() => {
          // Every vehicle's figure, or a partial note: a sum over some vehicles is not the fleet's.
          const got = vehicles.map(v => kpis[v.id]).filter((k): k is { kpi: Kpi } => !!k && 'kpi' in k).map(k => k.kpi)
          const missing = vehicles.length - got.length
          const failedKpis = vehicles.filter(v => { const k = kpis[v.id]; return k && 'error' in k }).length
          if (vehicles.length === 0) return <LtmTiles ltm={null} error="No GPU SPVs yet" />
          if (missing > 0) return <LtmTiles ltm={null} error={failedKpis > 0 ? `Partial: ${failedKpis} ${failedKpis === 1 ? 'vehicle' : 'vehicles'} could not be loaded` : 'Loading…'} />
          return <LtmTiles ltm={combineLtm(got)} base="Last 12 months, every GPU SPV" />
        })()}
      </div>

      {vehicles.length === 0 ? (
        <EmptyState icon={Server} action={addButton}>
          No GPU SPVs yet. Add a vehicle of kind GPU SPV to start its fleet register.
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {vehicles.map(v => {
            const l = loaded[v.id]
            const t = per.get(v.id)
            return (
              <Link key={v.id} href={`/funds/${v.id}`} data-vehicle={v.id} className="group rounded-card border bg-card p-4 shadow-sm transition-colors hover:bg-muted/30 dark:shadow-none">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium leading-tight group-hover:underline">{v.name}</p>
                    <p className="text-xs text-muted-foreground">GPU SPV{!v.active && ' · Inactive'}</p>
                  </div>
                  <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
                </div>
                {!l ? (
                  <Loader2 className="mt-3 h-4 w-4 animate-spin text-muted-foreground" />
                ) : 'error' in l ? (
                  <p role="alert" className="mt-2 text-sm text-destructive">{l.error}</p>
                ) : t && (
                  <dl className="mt-2 space-y-1 text-sm">
                    {([
                      ['GPUs', t.gpus.toLocaleString()],
                      ['In service', `${t.inService} of ${t.assets}`],
                      ['Basis', money(t.basis)],
                      ...(t.planned > 0 ? [['Planned', money(t.planned)] as const] : []),
                      ['NBV', money(t.nbvBook)],
                      ['Tax NBV', money(t.nbvTax)],
                    ] as const).map(([k, val]) => (
                      <div key={k} className="flex items-baseline justify-between gap-2">
                        <dt className="text-muted-foreground">{k}</dt>
                        <dd className="tabular-nums">{val}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </Link>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function FleetOverview({ vehicles }: { vehicles: FleetVehicle[] }) {
  const router = useRouter()
  // Creating a GPU SPV needs fleet write (POST /api/vehicles refuses it otherwise).
  const canAdd = useCanWrite('fleet')

  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})
  const [kpis, setKpis] = useState<Record<string, { kpi: Kpi } | { error: string }>>({})
  // Today in the user's own zone, sent explicitly: the route's own default is the UTC date.
  const [asOf] = useState(todayIso)
  useEffect(() => {
    let cancelled = false
    void mapBounded(vehicles, 4, async v => {
      const r = await listVehicleAssets(browserFetch, v.name, asOf)
      if (!cancelled) setLoaded(prev => ({ ...prev, [v.id]: r.ok ? { assets: r.data.assets } : { error: r.error } }))
    })
    const month = asOf.slice(0, 7)
    void mapBounded(vehicles, 4, async v => {
      const r = await getVehicleKpis(browserFetch, v.name, month)
      if (!cancelled) setKpis(prev => ({ ...prev, [v.id]: r.ok ? { kpi: r.data.ltm } : { error: r.error } }))
    })
    return () => { cancelled = true }
  }, [vehicles, asOf])

  return (
    <FleetOverviewView
      vehicles={vehicles}
      loaded={loaded}
      asOf={asOf}
      kpis={kpis}
      addButton={canAdd ? <AddVehicleButton onCreated={() => router.refresh()} /> : null}
    />
  )
}
