// Row shapes and vocabularies for the GPU fleet register (migration 20261019110000_gpu_assets.sql).
// Each list here mirrors a check constraint there; change both together.

export const GPU_ASSET_STATUSES = ['planned', 'ordered', 'in_service', 'offline', 'disposed'] as const
export type GpuAssetStatus = (typeof GPU_ASSET_STATUSES)[number]

export const DEPRECIATION_CONVENTIONS = ['full_month', 'mid_month'] as const
export type DepreciationConvention = (typeof DEPRECIATION_CONVENTIONS)[number]

/** Decision Q7: tax depreciation is chosen per asset, separately from book. */
export const TAX_METHODS = ['book', 'straight_line', 'macrs_5', 'macrs_7', 'bonus'] as const
export type TaxMethod = (typeof TAX_METHODS)[number]

/** Decision Q9: the manual record; there is no monitoring feed and no insurance-claim tracking. */
export const GPU_EVENT_KINDS = ['downtime', 'maintenance', 'rma', 'relocation', 'note'] as const
export type GpuEventKind = (typeof GPU_EVENT_KINDS)[number]

export const ESCALATION_BASES = ['anniversary', 'calendar_year'] as const
export type EscalationBasis = (typeof ESCALATION_BASES)[number]

/** Salvage when none is given: 10% of hardware cost (design §2.3). */
export const DEFAULT_SALVAGE_RATE = 0.1

export interface GpuAssetTypeRow {
  id: string
  fund_id: string
  code: string
  label: string
  gpu_model: string | null
  gpus_per_server: number
  anchor_rate: number | null
  notes: string | null
}

export interface GpuAssetRow {
  id: string
  fund_id: string
  vehicle_id: string
  asset_type_id: string | null
  name: string
  serials: string[]
  vendor_id: string | null
  status: GpuAssetStatus
  gpu_count: number
  hardware_cost: number
  purchase_date: string | null
  in_service_date: string | null
  useful_life_months: number
  salvage_value: number
  depreciation_convention: DepreciationConvention
  tax_method: TaxMethod
  tax_bonus_pct: number
  tax_life_years: number | null
  insurance_basis: number | null
  datacenter_contract_id: string | null
  purchase_entry_id: string | null
  disposed_on: string | null
  disposal_proceeds: number | null
  disposal_entry_id: string | null
  notes: string | null
}

/** A register row with its capitalized costs, derived from the posted capex entries (listAssets). */
export type GpuAsset = GpuAssetRow & { capitalized_costs: number }

export interface GpuAssetEventRow {
  id: string
  fund_id: string
  vehicle_id: string
  asset_id: string
  kind: GpuEventKind
  starts_at: string
  ends_at: string | null
  gpus_affected: number | null
  cause: string | null
}

export interface DatacenterContractRow {
  id: string
  fund_id: string
  vehicle_id: string
  vendor_id: string | null
  facility: string
  start_date: string
  end_date: string | null
  monthly_fee: number
  escalator_pct: number
  escalates_on: EscalationBasis
  first_escalation_date: string | null
  power_kw: number | null
  includes_connectivity: boolean
  deposit: number | null
  schedule_id: string | null
  allocation: 'none' | 'gpu_count'
  status: 'active' | 'ended'
}

export interface GpuFleetSettingsRow {
  id: string
  fund_id: string
  vehicle_id: string
  capex_contingency_budget: number
  /** ── GPU fleet (P3) ── The bank auto-match books a fitting payout itself (issue #92); off = propose. */
  auto_post_payout_matches: boolean
}
