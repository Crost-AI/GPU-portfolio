import type { SupabaseClient } from '@supabase/supabase-js'
import { listFirmEntities, type FirmEntity, type FirmEntityScope } from './firm-entities'
import { loadPostedLedger } from './load'
import { scheduleOfInvestments, type SoiRow } from './statements'
import { buildSoiPositions, type SoiCompany } from './soi'
import { hasSectionForKind } from './nav'

// HOLDINGS ACROSS THE FIRM: one row per company (or fund, or token), with which entities hold it
// and at what cost and value. The /funds/schedule-of-investments landing, which used to be a list
// of entities with an at-cost and at-value total each — the one question a firm-wide schedule is
// for ("who holds what, and where else do we hold it?") was the one it could not answer.
//
// Each entity's schedule is computed exactly as its own page does (tracker positions where the
// tracker has them, the ledger's per-company accounts where it does not), then merged by company.

export interface Holder { vehicleId: string; cost: number; fairValue: number }

export interface FirmHolding {
  key: string
  companyId: string | null
  name: string
  holdingType: 'company' | 'fund' | 'crypto'
  cost: number
  fairValue: number
  holders: Holder[]
}

export interface FirmHoldings {
  entities: (FirmEntity & { cost: number; fairValue: number })[]
  holdings: FirmHolding[]
  mancoOmitted: boolean
}

const r = (n: number) => Math.round(n * 100) / 100

/** Merge each entity's schedule rows into one row per company. Pure, so it is testable. */
export function mergeHoldings(perEntity: { vehicleId: string; rows: SoiRow[] }[]): FirmHolding[] {
  const byKey = new Map<string, FirmHolding>()
  for (const { vehicleId, rows } of perEntity) {
    for (const row of rows) {
      const key = row.companyId ?? `name:${row.name.trim().toLowerCase()}`
      const h = byKey.get(key) ?? {
        key, companyId: row.companyId ?? null, name: row.name,
        holdingType: row.holdingType ?? 'company', cost: 0, fairValue: 0, holders: [],
      }
      h.cost = r(h.cost + row.cost)
      h.fairValue = r(h.fairValue + row.fairValue)
      const existing = h.holders.find(x => x.vehicleId === vehicleId)
      if (existing) {
        existing.cost = r(existing.cost + row.cost)
        existing.fairValue = r(existing.fairValue + row.fairValue)
      } else {
        h.holders.push({ vehicleId, cost: row.cost, fairValue: row.fairValue })
      }
      byKey.set(key, h)
    }
  }
  return [...byKey.values()].sort((a, b) => b.fairValue - a.fairValue || a.name.localeCompare(b.name))
}

export async function loadFirmHoldings(admin: SupabaseClient, fundId: string, opts: FirmEntityScope): Promise<FirmHoldings> {
  // Only the entities that have a schedule of investments at all (not a GP entity or a manco).
  const entities = (await listFirmEntities(admin, fundId, opts)).filter(e => hasSectionForKind('schedule-of-investments', e.kind))
  if (entities.length === 0) return { entities: [], holdings: [], mancoOmitted: !opts.includeManco }

  const [{ data: txns, error: txnError }, { data: companies, error: companyError }] = await Promise.all([
    admin.from('investment_transactions' as any).select('*').eq('fund_id', fundId),
    admin.from('companies' as any).select('*').eq('fund_id', fundId),
  ])
  if (txnError) throw new Error(txnError.message)
  if (companyError) throw new Error(companyError.message)
  const companyList = ((companies as any[]) ?? []) as SoiCompany[]

  const perEntity = await Promise.all(entities.map(async e => {
    const ledger = await loadPostedLedger(admin, fundId, e.name)
    const positions = buildSoiPositions((txns as any[]) ?? [], companyList, e.name)
    const soi = scheduleOfInvestments(ledger.accounts, ledger.postings, 0, positions, companyList)
    return { vehicleId: e.id, rows: soi.rows }
  }))

  const totals = new Map(perEntity.map(p => [p.vehicleId, {
    cost: r(p.rows.reduce((s, x) => s + x.cost, 0)),
    fairValue: r(p.rows.reduce((s, x) => s + x.fairValue, 0)),
  }]))
  return {
    entities: entities.map(e => ({ ...e, ...(totals.get(e.id) ?? { cost: 0, fairValue: 0 }) })),
    holdings: mergeHoldings(perEntity),
    mancoOmitted: !opts.includeManco,
  }
}
