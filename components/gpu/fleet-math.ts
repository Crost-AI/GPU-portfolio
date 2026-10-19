// ── GPU fleet (P5) ── The figures the fleet pages show, from the register rows the fleet routes
// return. Pure, so the register, the asset page, the lead page and /fleet compute them one way.
//
// Book depreciation is lib/gpu/depreciation.ts's straight line on the hardware cost. The register
// rows carry capitalized costs as one total, not by the month each was booked, so they are added to
// NBV at cost: their depreciation (which starts in the month each is booked) is not netted here.
// That is exact until the first month-end after a capex; the ledger is the authority after that.

import { depreciableFromAsset, depreciationSchedule, monthEnd, nbvAsOf, type DepreciationLine } from '@/lib/gpu/depreciation'
import type { GpuAsset, GpuAssetStatus } from '@/lib/gpu/types'

export const todayIso = () => new Date().toISOString().slice(0, 10)

/** What a register row cost: the hardware plus everything capitalized into it. */
export const assetCost = (a: Pick<GpuAsset, 'hardware_cost' | 'capitalized_costs'>) =>
  round2(Number(a.hardware_cost) + Number(a.capitalized_costs ?? 0))

const round2 = (n: number) => Math.round(n * 100) / 100

export interface AssetFigures {
  cost: number
  /** Book depreciation charged through `asOf` (month ends on or before it). */
  accumulated: number
  /** Null once disposed: a disposed asset has no book value. */
  nbv: number | null
  /** Months of the schedule whose month end is after `asOf`; null before the asset is in service. */
  remainingMonths: number | null
}

/** The month-by-month book schedule of the hardware cost; empty until the asset is in service. */
export function assetSchedule(a: GpuAsset): DepreciationLine[] {
  const d = depreciableFromAsset(a)
  return d ? depreciationSchedule(d) : []
}

export function assetFigures(a: GpuAsset, asOf: string): AssetFigures {
  const cost = assetCost(a)
  const d = depreciableFromAsset(a)
  if (!d) return { cost, accumulated: 0, nbv: a.status === 'disposed' ? null : cost, remainingMonths: null }
  const hardwareNbv = nbvAsOf(d, asOf)
  const accumulated = round2(Number(a.hardware_cost) - hardwareNbv)
  const remainingMonths = depreciationSchedule(d).filter(l => monthEnd(l.month) > asOf).length
  return {
    cost,
    accumulated,
    nbv: a.status === 'disposed' ? null : round2(hardwareNbv + Number(a.capitalized_costs ?? 0)),
    remainingMonths: a.status === 'disposed' ? 0 : remainingMonths,
  }
}

export interface FleetTotals { assets: number; gpus: number; cost: number; nbv: number; inService: number }

/** The fleet as it stands: every asset not disposed of. */
export function fleetTotals(assets: GpuAsset[], asOf: string): FleetTotals {
  return assets.filter(a => a.status !== 'disposed').reduce<FleetTotals>((t, a) => {
    const f = assetFigures(a, asOf)
    return {
      assets: t.assets + 1,
      gpus: t.gpus + a.gpu_count,
      cost: round2(t.cost + f.cost),
      nbv: round2(t.nbv + (f.nbv ?? 0)),
      inService: t.inService + (a.status === 'in_service' ? 1 : 0),
    }
  }, { assets: 0, gpus: 0, cost: 0, nbv: 0, inService: 0 })
}

export const STATUS_LABEL: Record<GpuAssetStatus, string> = {
  planned: 'Planned', ordered: 'Ordered', in_service: 'In service', offline: 'Offline', disposed: 'Disposed',
}

/** Status badge classes: tokens only. planned/ordered/disposed muted, in service success, offline warning. */
export const STATUS_TONE: Record<GpuAssetStatus, string> = {
  planned: 'bg-muted text-muted-foreground',
  ordered: 'bg-muted text-muted-foreground',
  in_service: 'bg-success-subtle text-success',
  offline: 'bg-warning-subtle text-warning',
  disposed: 'bg-muted text-muted-foreground',
}
