// ── GPU fleet (P5) ── The figures the fleet pages show, from the register rows the fleet routes
// return. Pure, so the register, the asset page, the lead page and /fleet compute them one way.
//
// Book depreciation is lib/gpu/depreciation.ts's straight line on the hardware cost. The register
// rows carry capitalized costs as one total, not by the month each was booked, so they are added to
// NBV at cost: their depreciation (which starts in the month each is booked) is not netted here.
// That is exact until the first month-end after a capex; the ledger is the authority after that.
//
// Book value is only what the ledger holds. An asset is BOOKED once its purchase entry is linked
// (purchase_entry_id), the client-side half of assetLedgerState in lib/gpu/assets.ts (a live
// gpu-asset:<id>: entry). Until then its cost is PLANNED: shown on its own, never in NBV or the
// fleet NBV totals, and never depreciated, whatever its in-service date. The server's nbv_book
// replaces this rule when it lands (P5-2b).

import { depreciableFromAsset, depreciationSchedule, monthEnd, nbvAsOf, type DepreciationLine } from '@/lib/gpu/depreciation'
import type { GpuAsset, GpuAssetStatus } from '@/lib/gpu/types'
import { todayLocalIso } from '@/lib/local-date'

/** Today in the user's own time zone: the default entry date and the NBV as-of (not the UTC date). */
export const todayIso = todayLocalIso

/** Is anything booked for the asset? Its purchase entry is linked. See the note above. */
export const isBooked = (a: Pick<GpuAsset, 'purchase_entry_id'>) => !!a.purchase_entry_id

/** What a register row cost: the hardware plus everything capitalized into it. */
export const assetCost = (a: Pick<GpuAsset, 'hardware_cost' | 'capitalized_costs'>) =>
  round2(Number(a.hardware_cost) + Number(a.capitalized_costs ?? 0))

const round2 = (n: number) => Math.round(n * 100) / 100

export interface AssetFigures {
  cost: number
  /** False while the purchase is not booked: the cost is planned, with no NBV and no depreciation. */
  booked: boolean
  /** Book depreciation charged through `asOf` (month ends on or before it). */
  accumulated: number
  /** Null once disposed: a disposed asset has no book value. */
  nbv: number | null
  /** Months of the schedule whose month end is after `asOf`; null before the asset is in service. */
  remainingMonths: number | null
}

/** The month-by-month book schedule of the hardware cost; empty until it is booked and in service. */
export function assetSchedule(a: GpuAsset): DepreciationLine[] {
  const d = isBooked(a) ? depreciableFromAsset(a) : null
  return d ? depreciationSchedule(d) : []
}

export function assetFigures(a: GpuAsset, asOf: string): AssetFigures {
  const cost = assetCost(a)
  if (!isBooked(a)) return { cost, booked: false, accumulated: 0, nbv: null, remainingMonths: null }
  const d = depreciableFromAsset(a)
  if (!d) return { cost, booked: true, accumulated: 0, nbv: a.status === 'disposed' ? null : cost, remainingMonths: null }
  const hardwareNbv = nbvAsOf(d, asOf)
  const accumulated = round2(Number(a.hardware_cost) - hardwareNbv)
  const remainingMonths = depreciationSchedule(d).filter(l => monthEnd(l.month) > asOf).length
  return {
    cost,
    booked: true,
    accumulated,
    nbv: a.status === 'disposed' ? null : round2(hardwareNbv + Number(a.capitalized_costs ?? 0)),
    remainingMonths: a.status === 'disposed' ? 0 : remainingMonths,
  }
}

export interface FleetTotals {
  assets: number
  gpus: number
  /** Booked cost: what the ledger holds for the fleet. */
  cost: number
  /** Cost of assets whose purchase is not booked yet. Never part of `cost` or `nbv`. */
  planned: number
  nbv: number
  inService: number
}

export const ZERO_TOTALS: FleetTotals = { assets: 0, gpus: 0, cost: 0, planned: 0, nbv: 0, inService: 0 }

export function addTotals(a: FleetTotals, b: FleetTotals): FleetTotals {
  return {
    assets: a.assets + b.assets, gpus: a.gpus + b.gpus, cost: round2(a.cost + b.cost), planned: round2(a.planned + b.planned),
    nbv: round2(a.nbv + b.nbv), inService: a.inService + b.inService,
  }
}

/** The fleet as it stands: every asset not disposed of. Planned cost is counted apart from book value. */
export function fleetTotals(assets: GpuAsset[], asOf: string): FleetTotals {
  return assets.filter(a => a.status !== 'disposed').reduce<FleetTotals>((t, a) => {
    const f = assetFigures(a, asOf)
    return addTotals(t, {
      assets: 1,
      gpus: a.gpu_count,
      cost: f.booked ? f.cost : 0,
      planned: f.booked ? 0 : f.cost,
      nbv: f.nbv ?? 0,
      inService: a.status === 'in_service' ? 1 : 0,
    })
  }, ZERO_TOTALS)
}

/** The status moves a person may make (the PATCH route's OPERATIONAL_MOVES); the rest are the lifecycle's. */
export const STATUS_MOVES: Partial<Record<GpuAssetStatus, GpuAssetStatus[]>> = {
  ordered: ['in_service'],
  in_service: ['offline'],
  offline: ['in_service'],
}

/**
 * The moves on offer for this row. An ordered asset whose purchase is not linked yet is inside the
 * purchase's claim window, where the route refuses any status edit, so none is offered.
 */
export function statusMoves(a: Pick<GpuAsset, 'status' | 'purchase_entry_id'>): GpuAssetStatus[] {
  if (a.status === 'ordered' && !a.purchase_entry_id) return []
  return STATUS_MOVES[a.status] ?? []
}

export const MOVE_LABEL: Partial<Record<GpuAssetStatus, string>> = { in_service: 'Put in service', offline: 'Take offline' }

/** Purchase is the route's recovery path too: offered for any unlinked asset not disposed of. */
export const offersPurchase = (a: Pick<GpuAsset, 'status' | 'purchase_entry_id'>) => !a.purchase_entry_id && a.status !== 'disposed'
/** Dispose and capitalize act on a booked asset; the routes refuse both before the purchase is linked. */
export const offersBookedActions = (a: Pick<GpuAsset, 'status' | 'purchase_entry_id'>) => !!a.purchase_entry_id && a.status !== 'disposed'
/** Delete: a planned asset with nothing booked (the route's rule, as far as the row shows it). */
export const offersDelete = (a: Pick<GpuAsset, 'status' | 'purchase_entry_id'>) => a.status === 'planned' && !a.purchase_entry_id

/**
 * Who may press a button that books to the ledger: these routes need fleet write (the row) and
 * accounting write (the ledger). The hint names whichever is missing.
 */
export function bookingGate(canWriteFleet: boolean, canBook: boolean): { allowed: boolean; hint: string } {
  const missing = [!canWriteFleet && 'the GPU fleet', !canBook && 'Accounting'].filter(Boolean)
  return { allowed: missing.length === 0, hint: missing.length ? `This needs write access to ${missing.join(' and to ')}.` : '' }
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
