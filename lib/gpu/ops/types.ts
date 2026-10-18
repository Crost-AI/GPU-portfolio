// Row shapes for manual GPU operations entry (migration 20261019300000_gpu_ops_earnings.sql).
// Each list here mirrors a check constraint there; change both together.

export const EARNING_STATUSES = ['staged', 'unmatched', 'posted', 'ignored', 'reversed'] as const
export type EarningStatus = (typeof EARNING_STATUSES)[number]

/** Decision Q1: no marketplace integration. An API adapter would add a source here. */
export const IMPORT_SOURCES = ['manual', 'csv'] as const
export type ImportSource = (typeof IMPORT_SOURCES)[number]

export interface EarningRow {
  id: string
  fund_id: string
  vehicle_id: string
  run_id: string | null
  asset_id: string | null
  asset_ref: string
  machine_ref: string | null
  period_start: string
  period_end: string
  gpu_hours_rented: number
  utilization_pct: number
  gross: number
  marketplace_fee: number
  net: number
  downtime_hours: number
  note: string | null
  currency: string
  dedup_hash: string
  raw: unknown
  status: EarningStatus
  supersedes_id: string | null
  journal_entry_id: string | null
}

export interface PayoutRow {
  id: string
  fund_id: string
  vehicle_id: string
  payout_date: string
  amount: number
  reference: string | null
  note: string | null
  bank_transaction_id: string | null
  journal_entry_id: string | null
  status: 'expected' | 'matched'
}

/** The 1150 marketplace receivable, 4000 rental revenue and 5150 processing fee of GPU_SPV_CHART. */
export const RECEIVABLE_CODE = '1150'
export const REVENUE_CODE = '4000'
export const FEE_CODE = '5150'
export const CASH_CODE = '1000'

export const opsSourceRef = {
  earning: (earningId: string) => `marketplace:${earningId}`,
  payout: (payoutId: string) => `marketplace-payout:${payoutId}`,
}
