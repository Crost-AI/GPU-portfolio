// ── GPU fleet (P5) ── The fleet routes as the pages call them: one wrapper that turns any refusal
// into the route's own `error` text, and a builder per request body. The field names are the ones
// parseAssetInput (lib/gpu/assets.ts), parseContractInput (lib/gpu/opex.ts) and the lifecycle routes
// read; nothing here decides what is allowed, the routes do.

import type { DatacenterContractRow, GpuAsset, GpuAssetEventRow, GpuAssetStatus, GpuAssetTypeRow, GpuEventKind } from '@/lib/gpu/types'

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>

/** The page's own fetch, for requests that name their vehicle themselves (no VehicleScope). */
export const browserFetch: Fetcher = (path, init) => fetch(path, init)

export type Result<T> = { ok: true; data: T } | { ok: false; status: number; error: string }

export const CONNECTION_ERROR = 'Could not reach the server. Check the connection and try again.'

/** Call a route; a refusal comes back as the route's own message, never as a silent empty result. */
export async function call<T>(fetcher: Fetcher, path: string, init?: RequestInit): Promise<Result<T>> {
  let res: Response
  try {
    res = await fetcher(path, init)
  } catch {
    return { ok: false, status: 0, error: CONNECTION_ERROR }
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) return { ok: false, status: res.status, error: (body && typeof body.error === 'string' && body.error) || `Request failed (${res.status})` }
  return { ok: true, data: body as T }
}

export const send = <T>(fetcher: Fetcher, path: string, method: 'POST' | 'PATCH' | 'DELETE', body?: unknown) =>
  call<T>(fetcher, path, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })

const asset = (id: string) => `/api/fleet/assets/${encodeURIComponent(id)}`
const contract = (id: string) => `/api/fleet/datacenter-contracts/${encodeURIComponent(id)}`

export const fleetPaths = {
  types: '/api/fleet/asset-types',
  assets: '/api/fleet/assets',
  asset,
  purchase: (id: string) => `${asset(id)}/purchase`,
  capex: (id: string) => `${asset(id)}/capex`,
  dispose: (id: string) => `${asset(id)}/dispose`,
  events: (id: string) => `${asset(id)}/events`,
  contracts: '/api/fleet/datacenter-contracts',
  contract,
}

export const listTypes = (f: Fetcher) => call<{ assetTypes: GpuAssetTypeRow[] }>(f, fleetPaths.types)
export const listAssets = (f: Fetcher) => call<{ assets: GpuAsset[] }>(f, fleetPaths.assets)
export const listContracts = (f: Fetcher) => call<{ contracts: DatacenterContractRow[] }>(f, fleetPaths.contracts)
export const listEvents = (f: Fetcher, id: string) => call<{ events: GpuAssetEventRow[] }>(f, fleetPaths.events(id))

// ── Bodies ─────────────────────────────────────────────────────────────────────────────────────

/** A figure as typed: dollar signs, commas and spaces allowed ("1,000"); NaN when it is not a number. */
export const parseNumber = (s: string) => (s.trim() === '' ? NaN : Number(s.replace(/[$,\s]/g, '')))
const num = parseNumber

/** Is `s` an amount the form may send: a number, zero or more (or more than zero when `positive`)? */
export function validAmount(s: string, positive = false): boolean {
  const n = parseNumber(s)
  return Number.isFinite(n) && (positive ? n > 0 : n >= 0)
}
const blank = (s: string | undefined | null) => !s || !s.trim()

/** The asset form as typed. Blank optional fields are left to the route's defaults. */
export interface AssetForm {
  name: string
  /** On create: planned, or in service / offline for a fleet already running. On edit: the allowed moves. */
  status: GpuAssetStatus
  asset_type_id: string
  gpu_count: string
  hardware_cost: string
  serials: string
  useful_life_months: string
  salvage_value: string
  depreciation_convention: string
  in_service_date: string
  tax_method: string
  tax_bonus_pct: string
  tax_life_years: string
  insurance_basis: string
  datacenter_contract_id: string
  notes: string
}

export const EMPTY_ASSET_FORM: AssetForm = {
  name: '', status: 'planned', asset_type_id: '', gpu_count: '8', hardware_cost: '', serials: '', useful_life_months: '60',
  salvage_value: '', depreciation_convention: 'full_month', in_service_date: '', tax_method: 'book',
  tax_bonus_pct: '', tax_life_years: '', insurance_basis: '', datacenter_contract_id: '', notes: '',
}

/** Serials as typed: one per line, or comma-separated. */
export const parseSerials = (s: string) => s.split(/[\n,]/).map(x => x.trim()).filter(Boolean)

/**
 * The POST /api/fleet/assets body. Salvage left blank is the route's 10% of hardware cost; the bonus
 * percentage is typed as a percent and sent as the 0..1 fraction parseAssetInput reads.
 */
export function assetBody(f: AssetForm): Record<string, unknown> {
  const b: Record<string, unknown> = {
    name: f.name.trim(),
    gpu_count: num(f.gpu_count),
    hardware_cost: num(f.hardware_cost),
    serials: parseSerials(f.serials),
    depreciation_convention: f.depreciation_convention,
    tax_method: f.tax_method,
  }
  // Planned is the route's default; anything else is a running fleet being registered (or a move).
  if (f.status !== 'planned') b.status = f.status
  if (!blank(f.asset_type_id)) b.asset_type_id = f.asset_type_id
  if (!blank(f.useful_life_months)) b.useful_life_months = num(f.useful_life_months)
  if (!blank(f.salvage_value)) b.salvage_value = num(f.salvage_value)
  if (!blank(f.in_service_date)) b.in_service_date = f.in_service_date
  if (!blank(f.tax_bonus_pct)) b.tax_bonus_pct = num(f.tax_bonus_pct) / 100
  if (!blank(f.tax_life_years)) b.tax_life_years = num(f.tax_life_years)
  if (!blank(f.insurance_basis)) b.insurance_basis = num(f.insurance_basis)
  if (!blank(f.datacenter_contract_id)) b.datacenter_contract_id = f.datacenter_contract_id
  if (!blank(f.notes)) b.notes = f.notes.trim()
  return b
}

/** The register row as an edit form, for the Specs card. */
export function assetFormOf(a: GpuAsset): AssetForm {
  const s = (v: unknown) => (v == null ? '' : String(v))
  return {
    name: a.name, status: a.status, asset_type_id: s(a.asset_type_id), gpu_count: s(a.gpu_count), hardware_cost: s(a.hardware_cost),
    serials: (a.serials ?? []).join('\n'), useful_life_months: s(a.useful_life_months), salvage_value: s(a.salvage_value),
    depreciation_convention: a.depreciation_convention, in_service_date: s(a.in_service_date), tax_method: a.tax_method,
    tax_bonus_pct: a.tax_bonus_pct ? s(Math.round(Number(a.tax_bonus_pct) * 10000) / 100) : '', tax_life_years: s(a.tax_life_years),
    insurance_basis: s(a.insurance_basis), datacenter_contract_id: s(a.datacenter_contract_id), notes: s(a.notes),
  }
}

/**
 * Why the asset form cannot be saved yet, or null. On edit, salvage and useful life cannot be blank:
 * the route keeps the stored value for a field that is not sent, so clearing one would save nothing
 * while looking saved. (On create, blank salvage is the route's 10% default.)
 */
export function assetFormError(f: AssetForm, editing: boolean): string | null {
  if (!f.name.trim()) return 'Enter a name.'
  if (!Number.isInteger(parseNumber(f.gpu_count)) || parseNumber(f.gpu_count) <= 0) return 'GPUs must be a whole number above 0.'
  if (!validAmount(f.hardware_cost)) return 'Enter the hardware cost.'
  if (editing && !f.salvage_value.trim()) return 'Enter a salvage value (0 for none).'
  if (editing && !f.useful_life_months.trim()) return 'Enter the useful life in months.'
  for (const [k, label] of [['salvage_value', 'Salvage'], ['insurance_basis', 'Insurance basis'], ['tax_bonus_pct', 'Bonus %']] as const) {
    if (f[k].trim() && !validAmount(f[k])) return `${label} must be a number, zero or more.`
  }
  return null
}

/**
 * A PATCH body: only the fields that differ from the row, so an edit that leaves the cost alone does
 * not trip the "cost is booked" refusal. Blank optional fields that were set are cleared to null; a
 * cleared bonus is 0 (no bonus). Salvage and useful life cannot be cleared (assetFormError).
 */
export function assetPatch(a: GpuAsset, f: AssetForm): Record<string, unknown> {
  const before = assetFormOf(a)
  const full = assetBody(f)
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(f) as (keyof AssetForm)[]) {
    if (f[k] === before[k]) continue
    if (k in full) out[k] = full[k]
    else if (k === 'tax_bonus_pct') out[k] = 0
    else if (['asset_type_id', 'in_service_date', 'tax_life_years', 'insurance_basis', 'datacenter_contract_id', 'notes'].includes(k)) out[k] = null
  }
  return out
}

export interface TypeForm { code: string; label: string; gpu_model: string; gpus_per_server: string; anchor_rate: string }
export const EMPTY_TYPE_FORM: TypeForm = { code: '', label: '', gpu_model: '', gpus_per_server: '8', anchor_rate: '' }

export function typeBody(f: TypeForm): Record<string, unknown> {
  return {
    code: f.code.trim(),
    label: f.label.trim(),
    gpus_per_server: num(f.gpus_per_server),
    ...(blank(f.gpu_model) ? {} : { gpu_model: f.gpu_model.trim() }),
    ...(blank(f.anchor_rate) ? {} : { anchor_rate: num(f.anchor_rate) }),
  }
}

export const purchaseBody = (entryDate: string, invoiced: boolean) => ({ entryDate, invoiced })
export const disposeBody = (disposedOn: string, proceeds: string) => ({ disposedOn, proceeds: num(proceeds) })

export interface CapexForm { amount: string; entryDate: string; memo: string; invoiced: boolean }

/**
 * A capex submission with one idempotency key per dialog opening: every submit until `reset()` sends
 * the same key, so a retry after a timeout or a 409 books the cost once (the route's `key`).
 */
export function capexSubmitter(fetcher: Fetcher, assetId: string, newKey: () => string = () => crypto.randomUUID()) {
  let key = newKey()
  return {
    key: () => key,
    reset: () => { key = newKey() },
    submit: (f: CapexForm) => send<unknown>(fetcher, fleetPaths.capex(assetId), 'POST', {
      key, amount: num(f.amount), entryDate: f.entryDate, invoiced: f.invoiced, ...(blank(f.memo) ? {} : { memo: f.memo.trim() }),
    }),
  }
}

export interface EventForm { kind: GpuEventKind; starts_at: string; ends_at: string; gpus_affected: string; cause: string }

/**
 * A `datetime-local` value ('YYYY-MM-DDTHH:mm', the user's wall clock) as a UTC ISO timestamp. A bare
 * date is the start of that local day. The event log stores instants, so a two-hour outage stays two
 * hours whatever the time zone.
 */
export function localToUtc(s: string): string {
  const local = /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00` : s
  return new Date(local).toISOString()
}

/** A stored instant as the user's wall clock, 'YYYY-MM-DD HH:mm'. */
export function utcToLocalLabel(iso: string): string {
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Now, as a `datetime-local` value in the user's own time zone. */
export function nowLocalInput(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}T${p(now.getHours())}:${p(now.getMinutes())}`
}

const timestamp = localToUtc

export function eventBody(f: EventForm): Record<string, unknown> {
  return {
    kind: f.kind,
    starts_at: timestamp(f.starts_at),
    ends_at: blank(f.ends_at) ? null : timestamp(f.ends_at),
    gpus_affected: blank(f.gpus_affected) ? null : num(f.gpus_affected),
    ...(blank(f.cause) ? {} : { cause: f.cause.trim() }),
  }
}

export interface ContractForm {
  facility: string; start_date: string; end_date: string; monthly_fee: string; escalator_pct: string
  escalates_on: 'anniversary' | 'calendar_year'; first_escalation_date: string; power_kw: string; deposit: string
}

export const EMPTY_CONTRACT_FORM: ContractForm = {
  facility: '', start_date: '', end_date: '', monthly_fee: '', escalator_pct: '', escalates_on: 'anniversary',
  first_escalation_date: '', power_kw: '', deposit: '',
}

/**
 * POST /api/fleet/datacenter-contracts. `schedule` asks for the monthly accrual schedule too, which
 * books to the ledger and so needs accounting write; a fleet-only writer saves the contract alone.
 * Numbers go as JSON numbers: parseContractInput refuses numeric strings. The escalator is typed as a
 * percent and sent as the fraction.
 */
export function contractBody(f: ContractForm, schedule: boolean): Record<string, unknown> {
  return {
    facility: f.facility.trim(),
    start_date: f.start_date,
    monthly_fee: num(f.monthly_fee),
    escalator_pct: blank(f.escalator_pct) ? 0 : num(f.escalator_pct) / 100,
    escalates_on: f.escalates_on,
    ...(blank(f.end_date) ? {} : { end_date: f.end_date }),
    ...(blank(f.first_escalation_date) ? {} : { first_escalation_date: f.first_escalation_date }),
    ...(blank(f.power_kw) ? {} : { power_kw: num(f.power_kw) }),
    ...(blank(f.deposit) ? {} : { deposit: num(f.deposit) }),
    schedule,
  }
}

/** PATCH /api/fleet/assets/[id] for an operational move (ordered → in service, in service ↔ offline). */
export const statusBody = (status: GpuAssetStatus) => ({ status })

export const endContractBody = (endDate: string) => ({ end_date: endDate, status: 'ended' as const })
export const rollBody = (asOf: string) => ({ action: 'roll' as const, asOf })

/** One GPU SPV's register by name, outside a vehicle scope (the firm-wide /fleet page). */
export const listVehicleAssets = (f: Fetcher, vehicle: string) =>
  call<{ assets: GpuAsset[] }>(f, `${fleetPaths.assets}?group=${encodeURIComponent(vehicle)}`)

/** Run `fn` over `items` with at most `limit` in flight, results in input order. */
export async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i]) } }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}
