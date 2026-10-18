// The fleet register's data access: input validation, reads, per-asset ledger accounts, and the
// purchase and capitalized-cost entries. Callers (the /api/fleet routes) have already resolved the
// vehicle, checked its kind with assertVehicleKind, and checked `fleet` (and `accounting` write for
// anything that posts).

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { assetAccountCode } from '@/lib/accounting/chart'
import { fetchAllRows } from '@/lib/accounting/load'
import { persistEntry } from '@/lib/accounting/persist'
import { reversalRef } from '@/lib/accounting/reversal'
import { defaultSalvage, type CapexEvent } from './depreciation'
import { buildCapexEntry, buildPurchaseEntry, gpuSourceRef } from './entries'
import {
  DEPRECIATION_CONVENTIONS, GPU_ASSET_STATUSES, TAX_METHODS,
  type GpuAssetRow,
} from './types'

export const COST_BASE = '1600'
export const ACCUMULATED_BASE = '1650'
export const CASH_CODE = '1000'
export const ACCRUED_CODE = '2000'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN)

/** Fields a caller may set. `status: 'disposed'` and the entry/disposal columns are set by the lifecycle only. */
export type AssetInput = Partial<Omit<GpuAssetRow, 'id' | 'fund_id' | 'vehicle_id' | 'purchase_entry_id' | 'disposed_on' | 'disposal_proceeds' | 'disposal_entry_id'>>

/**
 * Validate a create (`partial: false`) or an update (`partial: true`) body. On create, `name`,
 * `gpu_count` and `hardware_cost` are required and salvage defaults to 10% of hardware cost.
 */
export function parseAssetInput(body: any, partial: boolean): { value: AssetInput } | { error: string } {
  const b = body ?? {}
  const out: AssetInput = {}
  const has = (k: string) => b[k] !== undefined

  if (has('name') || !partial) {
    if (typeof b.name !== 'string' || !b.name.trim()) return { error: 'name is required' }
    out.name = b.name.trim()
  }
  if (has('gpu_count') || !partial) {
    if (!Number.isInteger(num(b.gpu_count)) || num(b.gpu_count) <= 0) return { error: 'gpu_count must be a positive whole number' }
    out.gpu_count = num(b.gpu_count)
  }
  for (const k of ['hardware_cost', 'capitalized_costs', 'salvage_value', 'insurance_basis'] as const) {
    if (!has(k) && !(k === 'hardware_cost' && !partial)) continue
    if (k === 'insurance_basis' && b[k] === null) { out[k] = null; continue }
    if (!Number.isFinite(num(b[k])) || num(b[k]) < 0) return { error: `${k} must be zero or more` }
    out[k] = num(b[k])
  }
  if (has('useful_life_months')) {
    if (!Number.isInteger(num(b.useful_life_months)) || num(b.useful_life_months) <= 0) return { error: 'useful_life_months must be a positive whole number' }
    out.useful_life_months = num(b.useful_life_months)
  }
  for (const k of ['purchase_date', 'in_service_date'] as const) {
    if (!has(k)) continue
    if (b[k] !== null && !(typeof b[k] === 'string' && ISO_DATE.test(b[k]))) return { error: `${k} must be YYYY-MM-DD` }
    out[k] = b[k]
  }
  if (has('status')) {
    if (!GPU_ASSET_STATUSES.includes(b.status) || b.status === 'disposed') return { error: 'status must be planned, ordered, in_service or offline' }
    out.status = b.status
  }
  if (has('depreciation_convention')) {
    if (!DEPRECIATION_CONVENTIONS.includes(b.depreciation_convention)) return { error: 'depreciation_convention must be full_month or mid_month' }
    out.depreciation_convention = b.depreciation_convention
  }
  if (has('tax_method')) {
    if (!TAX_METHODS.includes(b.tax_method)) return { error: `tax_method must be one of ${TAX_METHODS.join(', ')}` }
    out.tax_method = b.tax_method
  }
  if (has('tax_bonus_pct')) {
    if (!Number.isFinite(num(b.tax_bonus_pct)) || num(b.tax_bonus_pct) < 0 || num(b.tax_bonus_pct) > 1) return { error: 'tax_bonus_pct must be between 0 and 1' }
    out.tax_bonus_pct = num(b.tax_bonus_pct)
  }
  if (has('tax_life_years')) {
    if (b.tax_life_years !== null && (!Number.isInteger(num(b.tax_life_years)) || num(b.tax_life_years) <= 0)) return { error: 'tax_life_years must be a positive whole number' }
    out.tax_life_years = b.tax_life_years === null ? null : num(b.tax_life_years)
  }
  const method = out.tax_method
  if (method && (method.startsWith('macrs_') || method === 'bonus') && out.tax_life_years != null) {
    const classes = method === 'macrs_5' ? [5] : method === 'macrs_7' ? [7] : [5, 7]
    if (!classes.includes(out.tax_life_years)) return { error: `tax_life_years must be ${classes.join(' or ')} for ${method}` }
  }
  if (has('serials')) {
    if (!Array.isArray(b.serials) || !b.serials.every((s: unknown) => typeof s === 'string')) return { error: 'serials must be a list of strings' }
    out.serials = b.serials
  }
  for (const k of ['asset_type_id', 'vendor_id', 'datacenter_contract_id', 'notes'] as const) {
    if (!has(k)) continue
    if (b[k] !== null && typeof b[k] !== 'string') return { error: `${k} must be a string` }
    out[k] = b[k]
  }
  if (!partial && out.salvage_value === undefined) out.salvage_value = defaultSalvage(out.hardware_cost!)
  return { value: out }
}

/** A vehicle's register, in a stable order (paged past PostgREST's 1,000-row cap). */
export async function listAssets(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<GpuAssetRow[]> {
  return fetchAllRows<GpuAssetRow>((f, t) => (admin as any).from('gpu_assets').select('*')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('created_at').range(f, t))
}

/** Account ids for `codes` in the vehicle's chart; throws naming any that are missing. */
export async function accountIdsByCode(admin: SupabaseClient, fundId: string, vehicleId: string, codes: string[]): Promise<Map<string, string>> {
  const { data, error } = await (admin as any).from('chart_of_accounts').select('id, code')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).in('code', codes)
  if (error) throw error
  const out = new Map<string, string>(((data as any[]) ?? []).map(r => [r.code, r.id]))
  const missing = codes.filter(c => !out.has(c))
  if (missing.length) throw new Error(`The chart has no account ${missing.join(', ')}`)
  return out
}

/** Provision the asset's 1600-<a> cost and 1650-<a> accumulated-depreciation accounts (idempotent). */
export async function ensureAssetAccounts(
  admin: SupabaseClient, fundId: string, group: string, vehicleId: string, asset: Pick<GpuAssetRow, 'id' | 'name'>,
): Promise<{ cost: string; accumulated: string }> {
  const cost = assetAccountCode(COST_BASE, asset.id)
  const accumulated = assetAccountCode(ACCUMULATED_BASE, asset.id)
  const { error } = await (admin as any).from('chart_of_accounts').upsert([
    { fund_id: fundId, vehicle_id: vehicleId, portfolio_group: group, code: cost, name: `GPU equipment — ${asset.name}`, type: 'asset', subtype: 'fixed_asset' },
    { fund_id: fundId, vehicle_id: vehicleId, portfolio_group: group, code: accumulated, name: `Accumulated depreciation — ${asset.name}`, type: 'asset', subtype: 'accumulated_depreciation' },
  ], { onConflict: 'fund_id,portfolio_group,code', ignoreDuplicates: true })
  if (error) throw error
  const ids = await accountIdsByCode(admin, fundId, vehicleId, [cost, accumulated])
  return { cost: ids.get(cost)!, accumulated: ids.get(accumulated)! }
}

export interface Lifecycle {
  fundId: string
  group: string
  vehicleId: string
  userId: string | null
}

/** The refusal when the asset row is not the caller's resolved vehicle's (another entity of the fund). */
export function otherVehicleError(ctx: Lifecycle, asset: Pick<GpuAssetRow, 'fund_id' | 'vehicle_id'>): { error: string } | null {
  return asset.fund_id === ctx.fundId && asset.vehicle_id === ctx.vehicleId ? null : { error: 'This asset belongs to another entity' }
}

/**
 * Book the hardware purchase (Dr 1600-<a> / Cr 1000, or Cr 2000 when `invoiced`) and link it.
 * A planned asset becomes ordered.
 *
 * Recoverable: the entry commits before the register is updated, so if that update fails a retry
 * hits the once-only index on `gpu-asset:<id>:purchase`, and the entry already there is linked
 * instead of a second one being booked.
 */
export async function purchaseAsset(
  admin: SupabaseClient, ctx: Lifecycle, asset: GpuAssetRow, p: { entryDate: string; invoiced: boolean },
): Promise<{ entryId: string } | { error: string }> {
  const other = otherVehicleError(ctx, asset)
  if (other) return other
  if (asset.purchase_entry_id) return { error: 'This asset\u2019s purchase is already booked' }
  const accounts = await ensureAssetAccounts(admin, ctx.fundId, ctx.group, ctx.vehicleId, asset)
  const offsetCode = p.invoiced ? ACCRUED_CODE : CASH_CODE
  const offset = (await accountIdsByCode(admin, ctx.fundId, ctx.vehicleId, [offsetCode])).get(offsetCode)!
  const entry = buildPurchaseEntry(
    { fundId: ctx.fundId, entryDate: p.entryDate, memo: `Purchase \u2014 ${asset.name}` },
    { assetId: asset.id, amount: Number(asset.hardware_cost), costAccountId: accounts.cost, offsetAccountId: offset },
  )
  const result = await persistEntry(admin, ctx.fundId, ctx.group, ctx.userId, entry, 'posted')
  const entryId = 'entryId' in result ? result.entryId : result.duplicateOf
  if (!entryId) return { error: (result as { error: string }).error }
  const { error } = await (admin as any).from('gpu_assets').update({
    purchase_entry_id: entryId, purchase_date: asset.purchase_date ?? p.entryDate,
    status: asset.status === 'planned' ? 'ordered' : asset.status, updated_at: new Date().toISOString(),
  }).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('id', asset.id)
  if (error) throw error
  return { entryId }
}

const CAPEX_KEY = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The asset's posted capex by month: each `gpu-asset:<id>:capex:<key>` entry's debit to 1600-<a>,
 * and each posted reversal of one as a negative amount in the reversal's month. What the depreciable
 * basis (depreciableFromAsset) and `capitalized_costs` are both derived from.
 */
export async function loadCapexEvents(
  admin: SupabaseClient, ctx: Lifecycle, assetId: string, costAccountId: string,
): Promise<CapexEvent[]> {
  const { data: capex, error } = await (admin as any).from('journal_entries').select('id, entry_date, journal_postings(account_id, amount)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('status', 'posted')
    .like('source_ref', `gpu-asset:${assetId}:capex:%`).order('id')
  if (error) throw error
  const rows: any[] = [...((capex as any[]) ?? [])]
  if (rows.length) {
    const { data: reversals, error: revError } = await (admin as any).from('journal_entries').select('id, entry_date, journal_postings(account_id, amount)')
      .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('status', 'posted')
      .in('source_ref', rows.map(r => reversalRef(r.id))).order('id')
    if (revError) throw revError
    rows.push(...((reversals as any[]) ?? []))
  }
  return rows.map(r => ({
    month: String(r.entry_date).slice(0, 7),
    amount: (r.journal_postings ?? []).filter((jp: any) => jp.account_id === costAccountId)
      .reduce((t: number, jp: any) => t + Math.round(Number(jp.amount) * 100), 0) / 100,
  })).filter(e => e.amount !== 0).sort((x, y) => (x.month < y.month ? -1 : x.month > y.month ? 1 : 0))
}

/**
 * `capitalized_costs` is DERIVED from the ledger, never incremented: Σ loadCapexEvents. Writes it to
 * the register and returns it, so a half-finished capitalization heals on the next call.
 */
export async function reconcileCapitalizedCosts(
  admin: SupabaseClient, ctx: Lifecycle, assetId: string, costAccountId: string,
): Promise<number> {
  const events = await loadCapexEvents(admin, ctx, assetId, costAccountId)
  const total = events.reduce((t, e) => t + Math.round(e.amount * 100), 0) / 100
  const { error } = await (admin as any).from('gpu_assets')
    .update({ capitalized_costs: total, updated_at: new Date().toISOString() }).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('id', assetId)
  if (error) throw error
  return total
}

/**
 * Capitalize a real installation, shipping or spares cost into the asset (decision R8/Q6), which
 * raises the depreciable basis and is what unspentContingency subtracts from the budget. Only a
 * purchased asset that is not disposed of (ordered, in service or offline) takes capex.
 *
 * Idempotent per `key` (the caller's identity for this cost, e.g. the invoice number): the entry is
 * `gpu-asset:<id>:capex:<key>`, so a retry finds it (or hits the once-only index) rather than
 * booking the cost again, and a key already used for a different amount is refused. Either way
 * the register is then reconciled from the ledger.
 */
export async function capitalizeCost(
  admin: SupabaseClient, ctx: Lifecycle, asset: GpuAssetRow,
  p: { key: string; entryDate: string; amount: number; invoiced: boolean; memo?: string },
): Promise<{ entryId: string; capitalizedCosts: number } | { error: string }> {
  const other = otherVehicleError(ctx, asset)
  if (other) return other
  if (asset.status === 'disposed' || asset.disposal_entry_id) return { error: 'A disposed asset cannot take capitalized costs' }
  if (!asset.purchase_entry_id) return { error: 'Book the asset\u2019s purchase before capitalizing costs into it' }
  if (!CAPEX_KEY.test(p.key ?? '')) return { error: 'key must be 1\u201364 letters, digits, hyphens or underscores' }
  if (!(p.amount > 0)) return { error: 'amount must be more than zero' }
  const accounts = await ensureAssetAccounts(admin, ctx.fundId, ctx.group, ctx.vehicleId, asset)
  const sourceRef = gpuSourceRef.capex(asset.id, p.key)

  const { data: found, error: findError } = await (admin as any).from('journal_entries').select('id, journal_postings(account_id, amount)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('source_ref', sourceRef).neq('status', 'void')
    .order('id').limit(1)
  if (findError) throw findError
  const existing = ((found as any[]) ?? [])[0]
  let entryId: string
  if (existing) {
    const booked = (existing.journal_postings ?? []).filter((jp: any) => jp.account_id === accounts.cost)
      .reduce((t: number, jp: any) => t + Math.round(Number(jp.amount) * 100), 0)
    if (booked !== Math.round(p.amount * 100)) return { error: `Key ${p.key} already capitalized ${booked / 100} on this asset` }
    entryId = existing.id
  } else {
    const offsetCode = p.invoiced ? ACCRUED_CODE : CASH_CODE
    const offset = (await accountIdsByCode(admin, ctx.fundId, ctx.vehicleId, [offsetCode])).get(offsetCode)!
    const entry = buildCapexEntry(
      { fundId: ctx.fundId, entryDate: p.entryDate, memo: p.memo ?? `Capitalized cost \u2014 ${asset.name}` },
      { assetId: asset.id, key: p.key, amount: p.amount, costAccountId: accounts.cost, offsetAccountId: offset },
    )
    const result = await persistEntry(admin, ctx.fundId, ctx.group, ctx.userId, entry, 'posted')
    const id = 'entryId' in result ? result.entryId : result.duplicateOf
    if (!id) return { error: (result as { error: string }).error }
    entryId = id
  }
  return { entryId, capitalizedCosts: await reconcileCapitalizedCosts(admin, ctx, asset.id, accounts.cost) }
}
