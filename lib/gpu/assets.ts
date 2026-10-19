// The fleet register's data access: input validation, reads, per-asset ledger accounts, and the
// purchase and capitalized-cost entries. Callers (the /api/fleet routes) have already resolved the
// vehicle, checked its kind with assertVehicleKind, and checked `fleet` (and `accounting` write for
// anything that posts).

import type { SupabaseClient } from '@supabase/supabase-js'
import { ACTUAL_BOOK } from '@/lib/accounting/books'
import { assetAccountCode } from '@/lib/accounting/chart'
import { addMonths } from '@/lib/forecast/months'
import { fetchAllRows, fetchAllRowsIn } from '@/lib/accounting/load'
import { persistEntry } from '@/lib/accounting/persist'
import { reversalRef } from '@/lib/accounting/reversal'
import type { JournalEntry } from '@/lib/accounting/types'
import { defaultSalvage, type CapexEvent } from './depreciation'
import { buildCapexEntry, buildPurchaseEntry, gpuSourceRef } from './entries'
import {
  DEPRECIATION_CONVENTIONS, GPU_ASSET_STATUSES, TAX_METHODS,
  type GpuAsset, type GpuAssetRow, type TaxMethod,
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
  for (const k of ['hardware_cost', 'salvage_value', 'insurance_basis'] as const) {
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
  if (out.tax_method) {
    const taxError = taxClassError(out.tax_method, out.tax_life_years ?? null)
    if (taxError) return { error: taxError }
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

/**
 * Why a tax method and class do not go together, or null. MACRS and bonus need a 5- or 7-year class
 * (macrs_5 → 5, macrs_7 → 7, bonus → either; unset means the method's own). Checked on the merged
 * row by the route as well, since an update may name only one of the two.
 */
export function taxClassError(method: TaxMethod, lifeYears: number | null): string | null {
  if (lifeYears == null || !(method.startsWith('macrs_') || method === 'bonus')) return null
  const classes = method === 'macrs_5' ? [5] : method === 'macrs_7' ? [7] : [5, 7]
  return classes.includes(lifeYears) ? null : `tax_life_years must be ${classes.join(' or ')} for ${method}`
}

/** Why the asset type or datacenter contract an asset names is not usable here, or null. */
export async function assetRefsError(admin: SupabaseClient, ctx: Pick<Lifecycle, 'fundId' | 'vehicleId'>, input: AssetInput): Promise<string | null> {
  if (input.asset_type_id) {
    const { data, error } = await (admin as any).from('gpu_asset_types').select('id').eq('fund_id', ctx.fundId).eq('id', input.asset_type_id).maybeSingle()
    if (error) throw error
    if (!data) return 'asset_type_id is not one of this fund\u2019s GPU types'
  }
  if (input.datacenter_contract_id) {
    const { data, error } = await (admin as any).from('datacenter_contracts').select('id')
      .eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('id', input.datacenter_contract_id).maybeSingle()
    if (error) throw error
    if (!data) return 'datacenter_contract_id is not one of this entity\u2019s contracts'
  }
  return null
}

/**
 * What the LEDGER holds for an asset, posted or draft: any lifecycle entry (`gpu-asset:<id>:…`) and
 * any depreciation (`gpu-dep:<id>:…`). A null purchase_entry_id does not mean unbooked: the purchase
 * commits before the register is linked, and an in-flight request holds a draft.
 */
export async function assetLedgerState(admin: SupabaseClient, ctx: Pick<Lifecycle, 'fundId' | 'vehicleId'>, assetId: string): Promise<{ booked: boolean; depreciated: boolean }> {
  const live = async (prefix: string) => {
    const { data, error } = await (admin as any).from('journal_entries').select('id')
      .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).neq('status', 'void')
      .like('source_ref', `${prefix}%`).order('id').limit(1)
    if (error) throw error
    return ((data as any[]) ?? []).length > 0
  }
  const [lifecycle, depreciated] = await Promise.all([live(`gpu-asset:${assetId}:`), live(`gpu-dep:${assetId}:`)])
  return { booked: lifecycle || depreciated, depreciated }
}

/** One asset's capitalized costs from its posted capex (0 before its cost account exists). */
export async function capitalizedCostsOf(admin: SupabaseClient, ctx: Lifecycle, assetId: string): Promise<number> {
  const { data, error } = await (admin as any).from('chart_of_accounts').select('id')
    .eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('code', assetAccountCode(COST_BASE, assetId)).maybeSingle()
  if (error) throw error
  if (!data) return 0
  return (await loadCapexEvents(admin, ctx, assetId, data.id)).reduce((t, e) => t + Math.round(e.amount * 100), 0) / 100
}

/**
 * A vehicle's register in a stable order (paged past PostgREST's 1,000-row cap), each row with its
 * `capitalized_costs` summed from the posted capex entries rather than read from a stored total.
 */
export async function listAssets(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<GpuAsset[]> {
  const rows = await fetchAllRows<GpuAssetRow>((f, t) => (admin as any).from('gpu_assets').select('*')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).order('created_at').range(f, t))
  const totals = await capexTotalsByAsset(admin, fundId, vehicleId)
  return rows.map(r => ({ ...r, capitalized_costs: (totals.get(r.id) ?? 0) / 100 }))
}

/** Posted capex per asset in cents, net of posted reversals: each entry's debit to its asset's 1600-<a>. */
async function capexTotalsByAsset(admin: SupabaseClient, fundId: string, vehicleId: string): Promise<Map<string, number>> {
  const capex = await fetchAllRows<any>((f, t) => (admin as any).from('journal_entries').select('id, source_ref, journal_postings(account_id, amount)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted')
    .like('source_ref', 'gpu-asset:%:capex:%').range(f, t))
  const out = new Map<string, number>()
  if (!capex.length) return out
  const reversals = await fetchAllRowsIn<any>(capex.map(e => reversalRef(e.id)), (chunk, f, t) => (admin as any).from('journal_entries')
    .select('id, source_ref, journal_postings(account_id, amount)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', fundId).eq('vehicle_id', vehicleId).eq('status', 'posted')
    .in('source_ref', chunk).range(f, t))
  // Paged: one 1600-<a> account per asset, so a large fleet passes PostgREST's 1,000-row cap.
  const chart = await fetchAllRows<any>((f, t) => (admin as any).from('chart_of_accounts').select('id, code')
    .eq('fund_id', fundId).eq('vehicle_id', vehicleId).like('code', `${COST_BASE}-%`).range(f, t))
  const codeOf = new Map<string, string>(chart.map(a => [a.id, a.code]))
  const assetOf = new Map<string, string>(capex.map(e => [e.id, String(e.source_ref).split(':')[1]]))
  for (const e of [...capex, ...reversals]) {
    const assetId = assetOf.get(e.id) ?? assetOf.get(String(e.source_ref).slice('reversal:'.length))
    if (!assetId) continue
    const c = (e.journal_postings ?? []).filter((jp: any) => codeOf.get(jp.account_id) === assetAccountCode(COST_BASE, assetId))
      .reduce((t: number, jp: any) => t + Math.round(Number(jp.amount) * 100), 0)
    out.set(assetId, (out.get(assetId) ?? 0) + c)
  }
  return out
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
 * The refusal for a ref whose entry is still a draft: another request is booking it, or persistEntry
 * kept it as a draft after a failure. It names the draft so a stuck one can be found and voided.
 */
export function inProgress(e: { id: string; entry_date: string }): { error: string; inProgress: true } {
  return {
    error: `Entry ${e.id} (${e.entry_date}) for this is still a draft: another request is booking it, or it was kept as a draft after a failure. Try again shortly, or void that draft.`,
    inProgress: true,
  }
}

/** A live (non-void) entry on the actual book, with its postings. */
export interface LiveEntry {
  id: string
  status: string
  entry_date: string
  source_type: string | null
  journal_postings: { account_id: string; amount: number }[]
}

/** The live entry on this vehicle's actual book carrying `sourceRef`, or null. */
export async function liveEntryByRef(admin: SupabaseClient, ctx: Lifecycle, sourceRef: string): Promise<LiveEntry | null> {
  const { data, error } = await (admin as any).from('journal_entries').select('id, status, entry_date, source_type, journal_postings(account_id, amount)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('source_ref', sourceRef).neq('status', 'void')
    .order('id').limit(1)
  if (error) throw error
  return ((data as any[]) ?? [])[0] ?? null
}

/** Whether a posted reversal (`reversal:<id>`) stands against an entry. */
async function isReversed(admin: SupabaseClient, ctx: Lifecycle, entryId: string): Promise<boolean> {
  const { data, error } = await (admin as any).from('journal_entries').select('id')
    .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('status', 'posted')
    .eq('source_ref', reversalRef(entryId)).order('id').limit(1)
  if (error) throw error
  return ((data as any[]) ?? []).length > 0
}

/**
 * Whether an entry found under a lifecycle ref may be adopted: posted, of the source type the
 * lifecycle writes (`sourceType`), and not reversed. A draft is in progress (inProgress). Anything
 * else under the ref was not booked by this lifecycle, or nets to zero in the ledger, so adopting it
 * would record a purchase or disposal the books do not hold; the once-only index keeps the ref
 * taken until it is voided.
 */
export async function adoptable(
  admin: SupabaseClient, ctx: Lifecycle, sourceRef: string, found: LiveEntry, sourceType: string,
): Promise<{ ok: true } | { error: string; inProgress?: true }> {
  if (found.status !== 'posted') return inProgress(found)
  if (found.source_type !== sourceType) {
    return { error: `Entry ${found.id} carries ${sourceRef} but was not booked by the fleet (${found.source_type ?? 'no type'}). Void it before booking this.` }
  }
  if (await isReversed(admin, ctx, found.id)) {
    return { error: `Entry ${found.id} (${sourceRef}) was booked and then reversed. Void both the entry and its reversal before booking this again, or, for a capitalized cost, use a new key.` }
  }
  return { ok: true }
}

/** An entry's postings to one account, in dollars. */
export function postedTo(e: LiveEntry, accountId: string): number {
  return (e.journal_postings ?? []).filter(jp => jp.account_id === accountId).reduce((t, jp) => t + Math.round(Number(jp.amount) * 100), 0) / 100
}

/**
 * Book `entry` once, keyed by its source_ref.
 *
 * An entry already carrying the ref is ADOPTED only when it is POSTED and NOT REVERSED (adoptable):
 * that is what an earlier attempt booked before its register update failed. A DRAFT is another
 * request still in flight (persistEntry writes a draft header, then the postings, then flips it to
 * posted, and deletes the draft if anything fails), so the answer is "in progress" and the caller
 * changes no register state.
 */
export async function bookOnce(
  admin: SupabaseClient, ctx: Lifecycle, entry: JournalEntry,
): Promise<{ booked: LiveEntry; adopted: boolean } | { error: string; inProgress?: true }> {
  const settle = async (found: LiveEntry | null) => {
    if (!found) return { error: `Could not read the entry already booked under ${entry.sourceRef}. Try again.` }
    const ok = await adoptable(admin, ctx, entry.sourceRef!, found, entry.sourceType ?? 'manual')
    return 'ok' in ok ? { booked: found, adopted: true } : ok
  }
  const found = await liveEntryByRef(admin, ctx, entry.sourceRef!)
  if (found) return settle(found)
  const result = await persistEntry(admin, ctx.fundId, ctx.group, ctx.userId, entry, 'posted')
  if ('entryId' in result) {
    return {
      adopted: false,
      booked: { id: result.entryId, status: 'posted', entry_date: entry.entryDate, source_type: entry.sourceType ?? null, journal_postings: entry.postings.map(p => ({ account_id: p.accountId, amount: p.amount })) },
    }
  }
  if (result.duplicateOf) return settle(await liveEntryByRef(admin, ctx, entry.sourceRef!))
  return { error: result.error }
}

/**
 * Book the hardware purchase (Dr 1600-<a> / Cr 1000, or Cr 2000 when `invoiced`) and link it.
 * A planned asset becomes ordered. A retry after a failed register update links the posted entry an
 * earlier attempt booked (bookOnce); one that meets a draft in flight is refused as in progress.
 */
export async function purchaseAsset(
  admin: SupabaseClient, ctx: Lifecycle, asset: GpuAssetRow, p: { entryDate: string; invoiced: boolean },
): Promise<{ entryId: string } | { error: string; inProgress?: true }> {
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
  // CLAIM the row before anything is booked: planned → ordered, only while it is still planned,
  // unlinked and at the cost this request read. DELETE and a cost edit run under the same
  // predicate (assets/[id]/route.ts), so whichever lands first wins and the other changes nothing.
  // An asset already past planned (a retry, or one ordered by hand) needs no claim: neither DELETE
  // nor a cost edit can touch it.
  const scoped = (q: any) => q.eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('id', asset.id)
  let claimed = false
  if (asset.status === 'planned') {
    const { data, error } = await scoped((admin as any).from('gpu_assets').update({ status: 'ordered', updated_at: new Date().toISOString() }))
      .eq('status', 'planned').is('purchase_entry_id', null).eq('hardware_cost', asset.hardware_cost).select('id')
    if (error) throw error
    if (!((data as any[]) ?? []).length) {
      return { error: 'This asset changed while its purchase was being booked (deleted, edited or booked by another request). Reload it and try again.', inProgress: true }
    }
    claimed = true
  }
  const result = await bookOnce(admin, ctx, entry)
  if ('error' in result) {
    // Nothing of ours is in the books (no draft under the ref): give the claim back.
    if (claimed && !(await liveEntryByRef(admin, ctx, entry.sourceRef!))) {
      await scoped((admin as any).from('gpu_assets').update({ status: 'planned', updated_at: new Date().toISOString() }))
        .eq('status', 'ordered').is('purchase_entry_id', null)
    }
    return result
  }
  const { data: linked, error } = await scoped((admin as any).from('gpu_assets').update({
    purchase_entry_id: result.booked.id, purchase_date: asset.purchase_date ?? result.booked.entry_date,
    status: asset.status === 'planned' ? 'ordered' : asset.status, updated_at: new Date().toISOString(),
  })).select('id')
  if (error) throw error
  // Never a success with a booked entry and no register row to show it: say so, by entry.
  if (!((linked as any[]) ?? []).length) {
    return { error: `The purchase is booked as entry ${result.booked.id}, but the asset was removed from the register meanwhile. Void entry ${result.booked.id}, or restore the asset and book the purchase again to link it.` }
  }
  return { entryId: result.booked.id }
}

export const CAPEX_KEY = /^[A-Za-z0-9_-]{1,64}$/

/** The asset's last depreciation month (in-service month + life, plus one under mid_month); null before in-service. */
export function lifeEndMonth(asset: Pick<GpuAssetRow, 'in_service_date' | 'useful_life_months' | 'depreciation_convention'>): string | null {
  if (!asset.in_service_date || !Number.isInteger(asset.useful_life_months)) return null
  return addMonths(asset.in_service_date.slice(0, 7), asset.useful_life_months - (asset.depreciation_convention === 'mid_month' ? 0 : 1))
}

/**
 * The asset's posted capex by month: each `gpu-asset:<id>:capex:<key>` entry's debit to 1600-<a>,
 * and each posted reversal of one as a negative amount in the reversal's month. The depreciable
 * basis (depreciableFromAsset) and `capitalized_costs` are both derived from it; nothing stores a total.
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
  return rows.map(r => ({ month: String(r.entry_date).slice(0, 7), amount: postedTo(r, costAccountId) }))
    .filter(e => e.amount !== 0).sort((x, y) => (x.month < y.month ? -1 : x.month > y.month ? 1 : 0))
}

/**
 * Depreciation on the books by month: each posted `gpu-dep:<id>:<YYYY-MM>[...]` entry's credit to
 * 1650-<a>, skipping an entry that has itself been reversed (a corrected month posts under a suffixed
 * ref and is added to its month). What depreciationSchedule takes as never-recomputed months.
 */
export async function loadPostedDepreciation(
  admin: SupabaseClient, ctx: Lifecycle, assetId: string, accumulatedAccountId: string,
): Promise<Map<string, number>> {
  const prefix = `gpu-dep:${assetId}:`
  const { data, error } = await (admin as any).from('journal_entries').select('id, source_ref, journal_postings(account_id, amount)')
    .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('status', 'posted')
    .like('source_ref', `${prefix}%`).order('id')
  if (error) throw error
  const rows: any[] = (data as any[]) ?? []
  const out = new Map<string, number>()
  if (!rows.length) return out
  const { data: rev, error: revError } = await (admin as any).from('journal_entries').select('source_ref')
    .eq('book', ACTUAL_BOOK).eq('fund_id', ctx.fundId).eq('vehicle_id', ctx.vehicleId).eq('status', 'posted')
    .in('source_ref', rows.map(r => reversalRef(r.id))).order('id')
  if (revError) throw revError
  const reversed = new Set(((rev as any[]) ?? []).map(r => String(r.source_ref).slice('reversal:'.length)))
  for (const r of rows) {
    if (reversed.has(r.id)) continue
    const month = String(r.source_ref).slice(prefix.length, prefix.length + 7)
    out.set(month, Math.round(((out.get(month) ?? 0) - postedTo(r, accumulatedAccountId)) * 100) / 100)
  }
  return out
}

/**
 * Capitalize a real installation, shipping or spares cost into the asset (decision R8/Q6), which
 * raises the depreciable basis and is what unspentContingency subtracts from the budget. Only a
 * purchased asset that is not disposed of (ordered, in service or offline) takes capex.
 *
 * Idempotent per `key` (the caller's identity for this cost, e.g. the invoice number): the entry is
 * `gpu-asset:<id>:capex:<key>`, so a retry adopts the posted entry rather than booking the cost
 * again (bookOnce), and a key already used for a different amount is refused. Nothing is written
 * to the register: `capitalizedCosts` is the ledger's total, read back.
 */
export async function capitalizeCost(
  admin: SupabaseClient, ctx: Lifecycle, asset: GpuAssetRow,
  p: { key: string; entryDate: string; amount: number; invoiced: boolean; memo?: string },
): Promise<{ entryId: string; capitalizedCosts: number } | { error: string; inProgress?: true }> {
  const other = otherVehicleError(ctx, asset)
  if (other) return other
  if (asset.status === 'disposed' || asset.disposal_entry_id) return { error: 'A disposed asset cannot take capitalized costs' }
  if (!asset.purchase_entry_id) return { error: 'Book the asset\u2019s purchase before capitalizing costs into it' }
  if (!CAPEX_KEY.test(p.key ?? '')) return { error: 'key must be 1\u201364 letters, digits, hyphens or underscores' }
  if (!(p.amount > 0)) return { error: 'amount must be more than zero' }
  if (!ISO_DATE.test(p.entryDate ?? '')) return { error: 'entryDate must be YYYY-MM-DD' }
  // A cost booked after the asset's last depreciation month would never be depreciated: refused.
  const end = lifeEndMonth(asset)
  if (end && p.entryDate.slice(0, 7) > end) return { error: `This asset's depreciable life ends in ${end}; a cost booked after it cannot be capitalized into it.` }
  const accounts = await ensureAssetAccounts(admin, ctx.fundId, ctx.group, ctx.vehicleId, asset)
  const offsetCode = p.invoiced ? ACCRUED_CODE : CASH_CODE
  const offset = (await accountIdsByCode(admin, ctx.fundId, ctx.vehicleId, [offsetCode])).get(offsetCode)!
  const entry = buildCapexEntry(
    { fundId: ctx.fundId, entryDate: p.entryDate, memo: p.memo ?? `Capitalized cost \u2014 ${asset.name}` },
    { assetId: asset.id, key: p.key, amount: p.amount, costAccountId: accounts.cost, offsetAccountId: offset },
  )
  const result = await bookOnce(admin, ctx, entry)
  if ('error' in result) return result
  const booked = postedTo(result.booked, accounts.cost)
  if (result.adopted && Math.round(booked * 100) !== Math.round(p.amount * 100)) return { error: `Key ${p.key} already capitalized ${booked} on this asset` }
  const events = await loadCapexEvents(admin, ctx, asset.id, accounts.cost)
  return { entryId: result.booked.id, capitalizedCosts: events.reduce((t, e) => t + Math.round(e.amount * 100), 0) / 100 }
}
