// The fleet schedule (pivot plan §5.4): a GPU SPV's statement exhibit in place of the schedule of
// investments. One row per server, read from the LEDGER — its 1600-<a> cost and 1650-<a>
// accumulated depreciation — with the register's detail (type, GPUs, in service) joined by asset id,
// so the schedule's total is the balance sheet's net equipment by construction (1600 − 1650).
//
// YTD revenue and utilisation wait for P3 (manual operations entry): null, never 0.
//
// Pure: the statement package supplies the chart, the postings to the period end and the register.

import { roundCents } from '@/lib/accounting/ledger'
import type { Account, Posting } from '@/lib/accounting/types'
import type { GpuAsset, GpuAssetTypeRow } from './types'

export interface FleetScheduleRow {
  /** Null for equipment on the parent 1600/1650 accounts, which no server's sub-account holds. */
  assetId: string | null
  /** The cost account's code, 1600-<a> (or 1600). */
  code: string
  name: string
  typeCode: string | null
  typeLabel: string | null
  gpus: number | null
  inServiceDate: string | null
  status: string | null
  /** At cost, a debit balance. */
  cost: number
  /** Accumulated depreciation, as a positive figure. */
  accumulated: number
  nbv: number
  /** P3 seam: revenue and utilisation year to date, not recorded yet. */
  ytdRevenue: number | null
  ytdUtilization: number | null
}

const COST = 'fixed_asset'
const ACCUMULATED = 'accumulated_depreciation'

/** `1600-abcd1234` → `abcd1234`; the parent `1600` → ''. */
const suffix = (code: string) => code.split('-').slice(1).join('-')

export function fleetSchedule(accounts: Account[], postings: Posting[], assets: GpuAsset[], types: GpuAssetTypeRow[]): FleetScheduleRow[] {
  const balance = new Map<string, number>()
  for (const p of postings) balance.set(p.accountId, (balance.get(p.accountId) ?? 0) + p.amount)
  const bySuffix = new Map<string, { cost: number; accumulated: number; costAccount?: Account }>()
  for (const a of accounts) {
    if (a.subtype !== COST && a.subtype !== ACCUMULATED) continue
    const key = suffix(a.code)
    const row = bySuffix.get(key) ?? { cost: 0, accumulated: 0 }
    if (a.subtype === COST) { row.cost += balance.get(a.id) ?? 0; row.costAccount = a }
    else row.accumulated -= balance.get(a.id) ?? 0
    bySuffix.set(key, row)
  }
  const assetBy = new Map(assets.map(x => [x.id.slice(0, 8), x]))
  const typeBy = new Map(types.map(t => [t.id, t]))
  const rows: FleetScheduleRow[] = []
  for (const [key, r] of bySuffix) {
    const cost = roundCents(r.cost)
    const accumulated = roundCents(r.accumulated)
    if (cost === 0 && accumulated === 0) continue
    const asset = key ? assetBy.get(key) : undefined
    const type = asset?.asset_type_id ? typeBy.get(asset.asset_type_id) : undefined
    rows.push({
      assetId: asset?.id ?? null,
      code: r.costAccount?.code ?? (key ? `1600-${key}` : '1600'),
      name: asset?.name ?? r.costAccount?.name ?? 'GPU equipment',
      typeCode: type?.code ?? null,
      typeLabel: type?.label ?? null,
      gpus: asset ? asset.gpu_count : null,
      inServiceDate: asset?.in_service_date ?? null,
      status: asset?.status ?? null,
      cost,
      accumulated,
      nbv: roundCents(cost - accumulated),
      ytdRevenue: null,
      ytdUtilization: null,
    })
  }
  return rows.sort((a, b) => a.code.localeCompare(b.code))
}
