import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '../../tests/helpers/memory-admin'
import { loadFundPreload } from './fund-preload'
import { loadEntityClasses, loadEntityNames, loadLedgerRowsBatch, loadOwnership, loadPostedLedger } from './load'
import { trialBalance } from './statements'

/**
 * The fund-wide preload and the ledger loaders must read every row, not the first 1000 (PostgREST
 * max_rows, supabase/config.toml), and must page in a stable order so no row repeats or vanishes
 * between pages. Every client here enforces that cap.
 */

const MAX_ROWS = 1000
const FUND = 'f'
const pad = (i: number) => String(i).padStart(5, '0')

/** `partners` LPs in each of two vehicles, each with a row per snapshot — the growth that crosses
 *  the cap long before a fund has 1000 partners. The latest snapshot carries the current figures. */
function lpBook(partners: number, snapshots: number) {
  const lp_entities = Array.from({ length: partners }, (_, i) => ({
    id: `e${pad(i)}`, fund_id: FUND, entity_name: `Partner ${i}`, partner_class: i === 0 ? 'gp' : 'lp',
  }))
  const lp_investments = ['Fund I', 'Fund II'].flatMap(group => lp_entities.flatMap(e => Array.from({ length: snapshots }, (_, s) => ({
    id: `i-${group}-${e.id}-${s}`, fund_id: FUND, entity_id: e.id, portfolio_group: group,
    commitment: 1000 * (s + 1), paid_in_capital: 100 * (s + 1), distributions: s,
    snapshot_id: `s${s}`, updated_at: '2024-01-01',
    lp_snapshots: { as_of_date: `202${s}-12-31`, created_at: `202${s}-12-31` },
  }))))
  // Oldest snapshot first, as they were inserted: a read truncated at the cap keeps the stale rows
  // and loses the latest snapshot.
  lp_investments.sort((a, b) => a.snapshot_id.localeCompare(b.snapshot_id))
  return { lp_entities, lp_investments }
}

const byEntity = (rows: { lpEntityId: string }[]) => [...rows].sort((a, b) => a.lpEntityId.localeCompare(b.lpEntityId))

describe('loadFundPreload reads past the 1000-row cap', () => {
  const vehicles = [
    { id: 'v1', fund_id: FUND, name: 'Fund I', aliases: [], vintage_year: 2020 },
    { id: 'v2', fund_id: FUND, name: 'Fund II', aliases: [], vintage_year: 2022 },
  ]

  it('reduces every partner from every snapshot, matching the per-vehicle loadOwnership', async () => {
    const { lp_entities, lp_investments } = lpBook(300, 3) // 1800 lp_investments rows
    const { admin } = memoryAdmin({ fund_vehicles: vehicles, lp_entities, lp_investments }, { maxRows: MAX_ROWS })
    const p = await loadFundPreload(admin as any, FUND)

    for (const group of ['Fund I', 'Fund II']) {
      const batched = p.ownershipByGroup.get(group)!
      expect(batched).toHaveLength(300)
      // Every partner on its LATEST snapshot (s2), none on a superseded one.
      expect(batched.every(o => o.commitment === 3000 && o.paidIn === 300 && o.distributions === 2)).toBe(true)
      expect(byEntity(batched)).toEqual(byEntity(await loadOwnership(admin as any, FUND, group)))
    }
  })

  it('names and classes every entity past the cap, matching the per-vehicle loaders', async () => {
    const { lp_entities, lp_investments } = lpBook(1200, 1)
    const { admin } = memoryAdmin({ fund_vehicles: vehicles, lp_entities, lp_investments }, { maxRows: MAX_ROWS })
    const p = await loadFundPreload(admin as any, FUND)
    expect(p.entityNames.size).toBe(1200)
    expect(p.entityClasses.size).toBe(1200)
    expect(p.entityNames.get('e01199')).toBe('Partner 1199')
    expect(p.entityClasses.get('e00000')).toBe('gp')
    expect(p.entityNames).toEqual(await loadEntityNames(admin as any, FUND, 'Fund I'))
    expect(p.entityClasses).toEqual(await loadEntityClasses(admin as any, FUND, 'Fund I'))
  })

  it.each(['fund_vehicles', 'lp_entities', 'lp_investments', 'fiscal_periods'])(
    'rejects when the %s read fails, instead of reading it as empty',
    async table => {
      const { lp_entities, lp_investments } = lpBook(2, 1)
      const m = memoryAdmin({ fund_vehicles: vehicles, lp_entities, lp_investments, fiscal_periods: [] }, { maxRows: MAX_ROWS })
      m.failNext(table, 'select', 'statement timeout')
      await expect(loadFundPreload(m.admin as any, FUND)).rejects.toMatchObject({ message: 'statement timeout' })
    },
  )
})

describe('the ledger loaders page in a stable order', () => {
  // One wrapper per chain, so `.eq().order().range()` keeps recording on the same chain.
  function recorder(admin: any) {
    const chains: { table: string; calls: string[] }[] = []
    const wrap = (table: string) => {
      const chain = { table, calls: [] as string[] }
      chains.push(chain)
      const q = admin.from(table)
      const proxy: any = new Proxy(q, {
        get(target, prop) {
          const v = target[prop]
          if (typeof v !== 'function' || prop === 'then') return v
          return (...args: unknown[]) => {
            chain.calls.push(String(prop))
            const out = v.apply(target, args)
            return out === target ? proxy : out
          }
        },
      })
      return proxy
    }
    return { chains, admin: { ...admin, from: wrap } }
  }
  const pagedWithoutOrder = (chains: { table: string; calls: string[] }[]) =>
    chains.filter(c => c.calls.includes('range') && !c.calls.slice(0, c.calls.indexOf('range')).includes('order')).map(c => c.table)

  it('orders every paged chart, entry and posting read (batched and single-vehicle)', async () => {
    const { admin } = memoryAdmin({ fund_vehicles: [{ id: 'v1', fund_id: FUND, name: 'Fund I' }] })
    const r = recorder(admin)
    await loadLedgerRowsBatch(r.admin as any, FUND, ['v1'])
    await loadPostedLedger(r.admin as any, FUND, 'Fund I')
    const paged = r.chains.filter(c => c.calls.includes('range')).map(c => c.table).sort()
    expect(paged).toEqual(['chart_of_accounts', 'chart_of_accounts', 'journal_entries', 'journal_entries', 'journal_postings', 'journal_postings'])
    expect(pagedWithoutOrder(r.chains)).toEqual([])
  })

  it('loads a >1000-posting ledger with every posting exactly once, and it ties', async () => {
    const n = 800 // 800 entries × 2 postings = 1600 postings
    const chart = [
      { id: 'cash', fund_id: FUND, vehicle_id: 'v1', code: '1000', name: 'Cash', type: 'asset', subtype: 'cash', lp_entity_id: null },
      { id: 'cap', fund_id: FUND, vehicle_id: 'v1', code: '3000', name: 'Capital', type: 'equity', subtype: null, lp_entity_id: null },
    ]
    const journal_entries = Array.from({ length: n }, (_, i) => ({
      id: `je${pad(i)}`, fund_id: FUND, vehicle_id: 'v1', book: 'actual', status: 'posted', entry_date: '2024-01-01', memo: null, source_type: 'manual',
    }))
    const journal_postings = journal_entries.flatMap(e => [
      { id: `${e.id}-d`, journal_entry_id: e.id, book: 'actual', fund_id: FUND, vehicle_id: 'v1', account_id: 'cash', amount: 100, currency: 'USD', lp_entity_id: null },
      { id: `${e.id}-c`, journal_entry_id: e.id, book: 'actual', fund_id: FUND, vehicle_id: 'v1', account_id: 'cap', amount: -100, currency: 'USD', lp_entity_id: null },
    ])
    const { admin } = memoryAdmin({ fund_vehicles: [{ id: 'v1', fund_id: FUND, name: 'Fund I' }], chart_of_accounts: chart, journal_entries, journal_postings }, { maxRows: MAX_ROWS })

    const single = await loadPostedLedger(admin as any, FUND, 'Fund I')
    const batched = (await loadLedgerRowsBatch(admin as any, FUND, ['v1'])).get('v1')!
    expect(single.postings).toHaveLength(1600)
    expect(batched.postingRows).toHaveLength(1600)
    expect(new Set(batched.postingRows.map((p: any) => `${p.journal_entry_id}|${p.account_id}`)).size).toBe(1600)
    const tb = trialBalance(single.accounts, single.postings)
    expect(tb.balanced).toBe(true)
    expect(tb.rows.find(r => r.accountId === 'cash')?.balance).toBe(80_000)
  })
})
