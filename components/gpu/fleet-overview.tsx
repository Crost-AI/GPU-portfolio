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
import type { GpuAsset } from '@/lib/gpu/types'
import { browserFetch, listVehicleAssets, mapBounded } from './fleet-api'
import { fleetTotals, todayIso, type FleetTotals } from './fleet-math'

// ── GPU fleet (P5) ── The firm-wide fleet: one card per GPU SPV with its GPUs, cost and book value,
// and the totals across them. Each vehicle's register is its own request (a few at a time); one that
// fails says so on its card and is left out of the totals, which then say they are partial.

export interface FleetVehicle { id: string; name: string; active: boolean }

type Loaded = { assets: GpuAsset[] } | { error: string }

const ZERO: FleetTotals = { assets: 0, gpus: 0, cost: 0, nbv: 0, inService: 0 }
const add = (a: FleetTotals, b: FleetTotals): FleetTotals => ({
  assets: a.assets + b.assets, gpus: a.gpus + b.gpus, cost: Math.round((a.cost + b.cost) * 100) / 100,
  nbv: Math.round((a.nbv + b.nbv) * 100) / 100, inService: a.inService + b.inService,
})

export function FleetOverview({ vehicles }: { vehicles: FleetVehicle[] }) {
  const router = useRouter()
  const currency = useCurrency()
  const money = (n: number) => formatCurrencyFull(n, currency)
  // Creating a GPU SPV needs fleet write (POST /api/vehicles refuses it otherwise).
  const canAdd = useCanWrite('fleet')
  const addButton = canAdd ? <AddVehicleButton onCreated={() => router.refresh()} /> : null

  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})
  useEffect(() => {
    let cancelled = false
    void mapBounded(vehicles, 4, async v => {
      const r = await listVehicleAssets(browserFetch, v.name)
      if (!cancelled) setLoaded(prev => ({ ...prev, [v.id]: r.ok ? { assets: r.data.assets } : { error: r.error } }))
    })
    return () => { cancelled = true }
  }, [vehicles])

  const asOf = todayIso()
  const per = new Map(vehicles.map(v => {
    const l = loaded[v.id]
    return [v.id, l && 'assets' in l ? fleetTotals(l.assets, asOf) : null]
  }))
  const totals = [...per.values()].reduce<FleetTotals>((t, x) => (x ? add(t, x) : t), ZERO)
  const pending = vehicles.filter(v => !loaded[v.id]).length
  const failed = vehicles.filter(v => { const l = loaded[v.id]; return l && 'error' in l }).length
  const partial = pending > 0 || failed > 0
  const shown = (n: string) => (vehicles.length === 0 ? '—' : n)
  const sub = pending > 0 ? 'Loading…' : failed > 0 ? `${failed} ${failed === 1 ? 'vehicle' : 'vehicles'} could not be loaded` : undefined

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="GPU SPVs" value={vehicles.length.toLocaleString()} sub={`${totals.inService} servers in service`} />
        <Metric label="GPUs" value={shown(totals.gpus.toLocaleString())} sub={partial ? sub : `${totals.assets} servers`} />
        <Metric label="Fleet cost" value={shown(money(totals.cost))} sub={partial ? sub : 'Hardware and capitalized costs'} />
        <Metric label="Fleet NBV" value={shown(money(totals.nbv))} sub={partial ? sub : 'Book value today'} />
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
              <Link key={v.id} href={`/funds/${v.id}`} className="group rounded-card border bg-card p-4 shadow-sm transition-colors hover:bg-muted/30 dark:shadow-none">
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
                  <p className="mt-2 text-sm text-destructive">{l.error}</p>
                ) : t && (
                  <dl className="mt-2 space-y-1 text-sm">
                    {([
                      ['GPUs', t.gpus.toLocaleString()],
                      ['In service', `${t.inService} of ${t.assets}`],
                      ['Cost', money(t.cost)],
                      ['NBV', money(t.nbv)],
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
