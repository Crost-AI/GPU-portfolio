// ── GPU fleet (P5) ── Presentation helpers for the fleet pages. No depreciation is computed here:
// every book and tax figure is the server's valuation (lib/gpu/valuation.ts, returned by the assets
// routes for ?as_of), so the register, the asset page, the lead page and /fleet show the same numbers
// the close books from. This file only adds them up and decides what each row offers.
//
// OFF THE BOOKS: a planned asset (status 'planned', the route's not-purchased state) or one whose
// purchase entry is not linked (the #94 recovery case). The valuation reports both at their full basis
// with nothing depreciated, but the ledger holds nothing linked to them, so their basis is shown in the
// Planned column (captioned Planned or Unbooked) and kept out of the book and tax totals. If the route
// comes to report 0 for an unbooked asset, the purchase_entry_id half of this rule can go.

import type { GpuAssetRow, GpuAssetStatus } from '@/lib/gpu/types'
import type { AssetValuation } from '@/lib/gpu/valuation'
import { todayLocalIso } from '@/lib/local-date'

/** A register row with its valuation as of a date, as GET /api/fleet/assets(/[id])?as_of returns it. */
export type ValuedAsset = GpuAssetRow & AssetValuation

/** Today in the user's own time zone: the default as-of and entry date (not the UTC date). */
export const todayIso = todayLocalIso

export const isPlanned = (a: Pick<GpuAssetRow, 'status'>) => a.status === 'planned'

/** Planned, or not linked to a purchase entry: its basis is not counted as book or tax value. */
export const isOffBooks = (a: Pick<GpuAssetRow, 'status' | 'purchase_entry_id'>) => isPlanned(a) || !a.purchase_entry_id

/** What an off-the-books row is called: planned (not purchased) or unbooked (purchase not linked). */
export const offBooksLabel = (a: Pick<GpuAssetRow, 'status'>) => (isPlanned(a) ? 'Planned' : 'Unbooked')

/**
 * Why an off-the-books asset shows no book or tax value. An unbooked asset may have its purchase
 * posted (the #94 recovery case: booked, but the link to the asset was not made), so it is not
 * "nothing booked": the entry is not linked, and its value is not counted until it is.
 */
export function offBooksReason(a: Pick<GpuAssetRow, 'status'>): { short: string; long: string } {
  return isPlanned(a)
    ? { short: 'Not purchased yet', long: 'Planned: the purchase is not booked yet, so the asset has no book or tax value. Its basis is shown at cost.' }
    : {
        short: 'Purchase not linked',
        long: 'Unbooked: the purchase entry is not linked to this asset, so its value is not counted until it is. Book the purchase again to link it.',
      }
}

/**
 * Was the asset disposed of by the date it is valued as of? The valuation's own rule (valueAssets:
 * disposed_on <= as_of gives NBV 0). An asset disposed later is still on the books at an earlier date,
 * so its figures count then, whatever its status today. Write actions follow the current status.
 */
export const disposedAsOf = (a: Pick<ValuedAsset, 'disposed_on' | 'valuation_as_of'>) =>
  !!a.disposed_on && a.disposed_on <= a.valuation_as_of

const round2 = (n: number) => Math.round(n * 100) / 100

export interface FleetTotals {
  assets: number
  gpus: number
  /** Basis of the assets on the books: hardware plus capitalized costs. */
  basis: number
  /** Basis of planned and unbooked assets (isOffBooks). Never part of the book or tax figures. */
  planned: number
  accumulatedBook: number
  nbvBook: number
  accumulatedTax: number
  nbvTax: number
  inService: number
}

export const ZERO_TOTALS: FleetTotals = {
  assets: 0, gpus: 0, basis: 0, planned: 0, accumulatedBook: 0, nbvBook: 0, accumulatedTax: 0, nbvTax: 0, inService: 0,
}

export function addTotals(a: FleetTotals, b: FleetTotals): FleetTotals {
  const out = { ...ZERO_TOTALS }
  for (const k of Object.keys(out) as (keyof FleetTotals)[]) out[k] = round2(a[k] + b[k])
  return out
}

/**
 * The fleet as it stood on the valuation date, from the server's figures: every asset not disposed of
 * by then (disposedAsOf), off-the-books apart.
 */
export function fleetTotals(assets: ValuedAsset[]): FleetTotals {
  return assets.filter(a => !disposedAsOf(a)).reduce<FleetTotals>((t, a) => {
    // Counts follow the status; only the money follows the on-books rule.
    const counts = { assets: 1, gpus: a.gpu_count, inService: a.status === 'in_service' ? 1 : 0 }
    return addTotals(t, isOffBooks(a)
      ? { ...ZERO_TOTALS, ...counts, planned: Number(a.basis) }
      : {
          ...counts, basis: Number(a.basis), planned: 0,
          accumulatedBook: Number(a.accumulated_book), nbvBook: Number(a.nbv_book),
          accumulatedTax: Number(a.accumulated_tax), nbvTax: Number(a.nbv_tax),
        })
  }, ZERO_TOTALS)
}

/**
 * The date the server valued these rows as of (valuation_as_of), or `fallback` when there are none.
 * Shown beside the figures, so a page says the date the server used, not the one it asked for.
 */
export function valuationDate(assets: Pick<ValuedAsset, 'valuation_as_of'>[], fallback: string | null = null): string | null {
  return assets.find(a => a.valuation_as_of)?.valuation_as_of ?? fallback
}

/**
 * Is the register valued as of a date before today? Then its totals may count an asset whose purchase
 * was booked after that date: the route reports such an asset in the unbooked shape (nothing
 * depreciated, NBV equal to basis), which the client cannot tell from one in service with no month end
 * yet. TODO(gpu-P1 on_books_as_of): when the assets route reports whether each asset was on the books
 * at the as-of date, count only those and drop this caption.
 */
export const mayCountLaterPurchases = (asOf: string | null, today: string = todayIso()) => !!asOf && asOf < today

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
export function statusMoves(a: Pick<GpuAssetRow, 'status' | 'purchase_entry_id'>): GpuAssetStatus[] {
  if (a.status === 'ordered' && !a.purchase_entry_id) return []
  return STATUS_MOVES[a.status] ?? []
}

export const MOVE_LABEL: Partial<Record<GpuAssetStatus, string>> = { in_service: 'Put in service', offline: 'Take offline' }

/** Purchase is the route's recovery path too: offered for any unlinked asset not disposed of. */
export const offersPurchase = (a: Pick<GpuAssetRow, 'status' | 'purchase_entry_id'>) => !a.purchase_entry_id && a.status !== 'disposed'
/** Dispose and capitalize act on a booked asset; the routes refuse both before the purchase is linked. */
export const offersBookedActions = (a: Pick<GpuAssetRow, 'status' | 'purchase_entry_id'>) => !!a.purchase_entry_id && a.status !== 'disposed'
/** Delete: a planned asset with nothing booked (the route's rule, as far as the row shows it). */
export const offersDelete = (a: Pick<GpuAssetRow, 'status' | 'purchase_entry_id'>) => a.status === 'planned' && !a.purchase_entry_id

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
