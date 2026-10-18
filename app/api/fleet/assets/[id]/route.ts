import { NextRequest, NextResponse } from 'next/server'
import { assetLedgerState, assetRefsError, capitalizedCostsOf, parseAssetInput, taxClassError } from '@/lib/gpu/assets'
import { fleetRowRequest } from '@/lib/gpu/http'
import type { GpuAssetRow } from '@/lib/gpu/types'

// ── GPU fleet (P1) ── One server (`fleet` domain). The row's own vehicle is the entity checked.

type Params = { params: Promise<{ id: string }> }

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
  const { data, error } = await (r.req.admin as any).from('gpu_assets').update({ ...parsed.value, updated_at: new Date().toISOString() })
    .eq('fund_id', r.req.fundId).eq('vehicle_id', r.req.vehicleId).eq('id', id).select('*').single()
  if (error) return NextResponse.json({ error: 'Could not save the asset' }, { status: 500 })
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
  const { error } = await (r.req.admin as any).from('gpu_assets').delete()
    .eq('fund_id', r.req.fundId).eq('vehicle_id', r.req.vehicleId).eq('id', id).eq('status', 'planned').is('purchase_entry_id', null)
  if (error) return NextResponse.json({ error: 'Could not delete the asset' }, { status: 500 })
  return NextResponse.json({ deleted: id })
}
