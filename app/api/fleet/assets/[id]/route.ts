import { NextRequest, NextResponse } from 'next/server'
import { assetLedgerState, assetRefsError, capitalizedCostsOf, parseAssetInput, taxClassError } from '@/lib/gpu/assets'
import { fleetRowRequest } from '@/lib/gpu/http'
import type { GpuAssetRow } from '@/lib/gpu/types'

// ── GPU fleet (P1) ── One server (`fleet` domain). The row's own vehicle is the entity checked.

type Params = { params: Promise<{ id: string }> }

/** The status moves a person may make through PATCH. */
const OPERATIONAL_MOVES: Record<string, string[]> = { ordered: ['in_service'], in_service: ['offline'], offline: ['in_service'] }

export async function GET(_req: NextRequest, props: Params) {
  const { id } = await props.params
  const r = await fleetRowRequest<GpuAssetRow>('read', 'gpu_assets', id)
  if (r instanceof NextResponse) return r
  return NextResponse.json({ ...r.row, capitalized_costs: await capitalizedCostsOf(r.req.admin, r.req.ctx, id) })
}

// PATCH — edit the register row. A disposed asset is closed. What the LEDGER holds decides the rest
// (a null purchase_entry_id does not mean unbooked): the hardware cost is fixed once anything is
// booked for the asset, and the in-service date and convention once any depreciation is. The tax
// class is checked on the merged row.
export async function PATCH(req: NextRequest, props: Params) {
  const { id } = await props.params
  const r = await fleetRowRequest<GpuAssetRow>('write', 'gpu_assets', id)
  if (r instanceof NextResponse) return r
  const parsed = parseAssetInput(await req.json().catch(() => ({})), true)
  if ('error' in parsed) return NextResponse.json({ error: parsed.error }, { status: 400 })
  const row = r.row
  if (row.status === 'disposed') return NextResponse.json({ error: 'A disposed asset cannot be edited' }, { status: 409 })
  const v = parsed.value
  // Status through the register is operational only. `ordered` is the purchase's claim (purchaseAsset)
  // and `disposed` the disposal's (disposeAsset); nothing goes back to `planned` once it has left it,
  // which would release a claim and reopen DELETE.
  // The claim window (ordered, purchase not yet linked) is the purchase's: no status edit at all.
  if (v.status !== undefined && row.status === 'ordered' && !row.purchase_entry_id) {
    return NextResponse.json({ error: 'The purchase of this asset is being booked; its status can change once the purchase is linked' }, { status: 409 })
  }
  if (v.status !== undefined && v.status !== row.status && !(OPERATIONAL_MOVES[row.status] ?? []).includes(v.status)) {
    return NextResponse.json({ error: `Status cannot change from ${row.status} to ${v.status} here: an asset is ordered by booking its purchase and disposed of by its disposal, and never returns to planned` }, { status: 409 })
  }
  const costChange = v.hardware_cost !== undefined && v.hardware_cost !== Number(row.hardware_cost)
  const scheduleChange = (v.in_service_date !== undefined && v.in_service_date !== row.in_service_date)
    || (v.depreciation_convention !== undefined && v.depreciation_convention !== row.depreciation_convention)
  if (costChange || scheduleChange) {
    const ledger = await assetLedgerState(r.req.admin, r.req.ctx, id)
    if (costChange && (row.purchase_entry_id || ledger.booked)) {
      return NextResponse.json({ error: 'The hardware cost is booked; correct it in the ledger, not the register' }, { status: 409 })
    }
    if (scheduleChange && ledger.depreciated) {
      return NextResponse.json({ error: 'Depreciation is already booked; the in-service date and convention cannot change' }, { status: 409 })
    }
  }
  const taxError = taxClassError(parsed.value.tax_method ?? row.tax_method, parsed.value.tax_life_years !== undefined ? parsed.value.tax_life_years : row.tax_life_years)
  if (taxError) return NextResponse.json({ error: taxError }, { status: 400 })
  const refs = await assetRefsError(r.req.admin, r.req.ctx, parsed.value)
  if (refs) return NextResponse.json({ error: refs }, { status: 400 })
  // A cost change applies only while the asset is still planned and unlinked: the same predicate the
  // purchase claims under, so a purchase that claimed the row first leaves this matching nothing.
  let q = (r.req.admin as any).from('gpu_assets').update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq('fund_id', r.req.fundId).eq('vehicle_id', r.req.vehicleId).eq('id', id)
  if (costChange) q = q.eq('status', 'planned').is('purchase_entry_id', null).eq('hardware_cost', row.hardware_cost)
  // A status in the payload applies only from the status this request read, so a stale form save
  // cannot overwrite a purchase's claim (or anything else that moved the row meanwhile).
  else if (v.status !== undefined) {
    q = q.eq('status', row.status)
    if (row.status === 'ordered') q = q.not('purchase_entry_id', 'is', null)
  }
  const { data: saved, error } = await q.select('*')
  if (error) return NextResponse.json({ error: 'Could not save the asset' }, { status: 500 })
  const data = ((saved as any[]) ?? [])[0]
  if (!data) {
    return NextResponse.json({ error: costChange
      ? 'The hardware cost can change only while the asset is planned and nothing is booked'
      : 'The asset changed while you were editing it (a purchase or another edit); reload it and try again' }, { status: 409 })
  }
  return NextResponse.json({ ...data, capitalized_costs: await capitalizedCostsOf(r.req.admin, r.req.ctx, id) })
}

// DELETE — only a planned asset with nothing in the ledger (posted or in flight); anything else has
// a history to keep.
export async function DELETE(_req: NextRequest, props: Params) {
  const { id } = await props.params
  const r = await fleetRowRequest<GpuAssetRow>('write', 'gpu_assets', id)
  if (r instanceof NextResponse) return r
  if (r.row.status !== 'planned' || r.row.purchase_entry_id || (await assetLedgerState(r.req.admin, r.req.ctx, id)).booked) {
    return NextResponse.json({ error: 'Only a planned asset with nothing booked can be deleted' }, { status: 409 })
  }
  // Under the purchase's claim predicate: a purchase that claimed the row first leaves nothing to delete.
  const { data: gone, error } = await (r.req.admin as any).from('gpu_assets').delete()
    .eq('fund_id', r.req.fundId).eq('vehicle_id', r.req.vehicleId).eq('id', id).eq('status', 'planned').is('purchase_entry_id', null).select('id')
  if (error) return NextResponse.json({ error: 'Could not delete the asset' }, { status: 500 })
  if (!((gone as any[]) ?? []).length) return NextResponse.json({ error: 'Only a planned asset with nothing booked can be deleted' }, { status: 409 })
  return NextResponse.json({ deleted: id })
}
