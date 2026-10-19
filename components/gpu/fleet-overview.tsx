'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowRight, Server } from 'lucide-react'
import { Metric } from '@/components/ui/metric'
import { EmptyState } from '@/components/ui/empty-state'
import { AddVehicleButton } from '@/components/add-vehicle-button'
import { useCanWrite } from '@/components/access-context'

// ── GPU fleet (P5) ── The firm-wide fleet: one card per GPU SPV, and the fleet's totals across them.
// The totals are dashes until the fleet overview route lands (P5-2).

export interface FleetVehicle { id: string; name: string; active: boolean }

export function FleetOverview({ vehicles }: { vehicles: FleetVehicle[] }) {
  const router = useRouter()
  // Creating a GPU SPV needs fleet write (POST /api/vehicles refuses it otherwise).
  const canAdd = useCanWrite('fleet')
  const addButton = canAdd ? <AddVehicleButton onCreated={() => router.refresh()} /> : null

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric label="GPU SPVs" value={vehicles.length.toLocaleString()} />
        <Metric label="Fleet NBV" value="—" sub="Fills in with the fleet register (P5-2)" />
        <Metric label="LTM revenue" value="—" sub="Fills in with revenue entry (P5-4)" />
        <Metric label="Utilization" value="—" sub="Fills in with revenue entry (P5-4)" />
      </div>

      {vehicles.length === 0 ? (
        <EmptyState icon={Server} action={addButton}>
          No GPU SPVs yet. Add a vehicle of kind GPU SPV to start its fleet register.
        </EmptyState>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {vehicles.map(v => (
            <Link key={v.id} href={`/funds/${v.id}`} className="group rounded-card border bg-card p-4 shadow-sm transition-colors hover:bg-muted/30 dark:shadow-none">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium leading-tight group-hover:underline">{v.name}</p>
                  <p className="text-xs text-muted-foreground">GPU SPV{!v.active && ' · Inactive'}</p>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-muted-foreground group-hover:text-foreground" />
              </div>
              <div className="mt-2 flex items-baseline justify-between gap-2 text-sm">
                <span className="text-muted-foreground">NBV</span>
                <span className="tabular-nums text-muted-foreground">&mdash;</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
