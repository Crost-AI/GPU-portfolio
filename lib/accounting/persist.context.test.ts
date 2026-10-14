// persistEntry with a PersistContext: the four per-entry lookups come from the context, not the
// database — and the checks they feed (closed period, foreign account) still hold.
import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { buildPersistContext, persistEntry, type PersistContext } from './persist'

const LOOKUPS = ['fund_settings', 'fiscal_periods', 'fund_vehicles', 'chart_of_accounts']

function seed() {
  const m = memoryAdmin({
    fund_settings: [{ fund_id: 'f', currency: 'EUR' }],
    fund_vehicles: [{ id: 'v', fund_id: 'f', name: 'Fund I', aliases: [] }],
    fiscal_periods: [{ fund_id: 'f', vehicle_id: 'v', status: 'closed', period_start: '2026-01-01', period_end: '2026-03-31' }],
    chart_of_accounts: [
      { id: 'cash', fund_id: 'f', vehicle_id: 'v', code: '1000' },
      { id: 'expense', fund_id: 'f', vehicle_id: 'v', code: '5100' },
    ],
  })
  const reads: string[] = []
  const from = m.admin.from
  m.admin.from = (t: string) => { reads.push(t); return from(t) }
  return { m, reads }
}
const entry = (entryDate: string, debit = 'expense') => ({
  fundId: 'f', entryDate, memo: 'Software',
  postings: [{ accountId: debit, amount: 55, currency: 'USD', lpEntityId: null }, { accountId: 'cash', amount: -55, currency: 'USD', lpEntityId: null }],
})
const ctx: PersistContext = {
  fundId: 'f', group: 'Fund I', currency: 'GBP', vehicleId: 'v', accountIds: new Set(['cash', 'expense']),
  closedRanges: [{ period_start: '2026-01-01', period_end: '2026-03-31' }],
}
const draft = (m: any, e: any, c?: PersistContext) => persistEntry(m.admin, 'f', 'Fund I', 'u', e, 'draft', 'actual', true, {}, c)

describe('persistEntry with a context', () => {
  it('reads none of the four lookups, and writes with the context currency and vehicle', async () => {
    const { m, reads } = seed()
    const r = await draft(m, entry('2026-05-01'), ctx)
    expect(r).toEqual({ entryId: expect.any(String) })
    expect(reads.filter(t => LOOKUPS.includes(t))).toEqual([])
    expect(m.tables.journal_entries[0]).toMatchObject({ vehicle_id: 'v', status: 'draft' })
    expect(m.tables.journal_postings.every((p: any) => p.currency === 'GBP' && p.vehicle_id === 'v')).toBe(true)
  })

  it('still refuses a date in a closed period from the context', async () => {
    const { m, reads } = seed()
    expect(await draft(m, entry('2026-02-10'), ctx)).toEqual({ error: 'The period covering 2026-02-10 is closed — reopen it to post here' })
    expect(reads.filter(t => LOOKUPS.includes(t))).toEqual([])
    expect(m.tables.journal_entries ?? []).toEqual([])
  })

  it('still refuses an account outside the context chart', async () => {
    const { m } = seed()
    expect(await draft(m, entry('2026-05-01', 'elsewhere'), ctx)).toEqual({ error: "Posting to an account that doesn't belong to Fund I: elsewhere" })
    expect(m.tables.journal_entries ?? []).toEqual([])
  })

  it('refuses a context read for another fund or vehicle', async () => {
    const { m } = seed()
    for (const other of [{ ...ctx, group: 'Fund II' }, { ...ctx, fundId: 'g' }]) {
      expect(await draft(m, entry('2026-05-01'), other)).toEqual({ error: expect.stringMatching(/not Fund I — nothing was saved/) })
    }
    expect(m.tables.journal_entries ?? []).toEqual([])
  })

  it('without a context reads them as before', async () => {
    const { m, reads } = seed()
    expect(await draft(m, entry('2026-05-01'))).toEqual({ entryId: expect.any(String) })
    for (const t of ['fiscal_periods', 'fund_vehicles', 'chart_of_accounts']) expect(reads).toContain(t)
  })
})

describe('buildPersistContext', () => {
  it('reads the four lookups once', async () => {
    const { m } = seed()
    const c = await buildPersistContext(m.admin, 'f', 'Fund I')
    expect(c).toEqual({
      fundId: 'f', group: 'Fund I', currency: expect.any(String), vehicleId: 'v', accountIds: new Set(['cash', 'expense']),
      closedRanges: [{ period_start: '2026-01-01', period_end: '2026-03-31' }],
    })
  })

  it('reuses a known vehicle id and chart instead of reading them', async () => {
    const { m, reads } = seed()
    const c = await buildPersistContext(m.admin, 'f', 'Fund I', { vehicleId: 'v', accountIds: new Set(['cash']) })
    expect(c).toMatchObject({ vehicleId: 'v', accountIds: new Set(['cash']) })
    expect(reads).not.toContain('fund_vehicles')
    expect(reads).not.toContain('chart_of_accounts')
  })

  it('refuses an unknown vehicle with persistEntry\'s text', async () => {
    const { m } = seed()
    expect(await buildPersistContext(m.admin, 'f', 'Fund IX')).toEqual({ error: 'Unknown vehicle "Fund IX" — add it in Settings before booking to it.' })
  })

  it('refuses, rather than reading "no closed periods", when the periods cannot be read', async () => {
    const { m } = seed()
    m.failNext('fiscal_periods', 'select', 'connection reset')
    expect(await buildPersistContext(m.admin, 'f', 'Fund I')).toEqual({ error: 'The closed periods could not be read: connection reset' })
  })

  it('refuses when the chart cannot be read', async () => {
    const { m } = seed()
    m.failNext('chart_of_accounts', 'select', 'timeout')
    expect(await buildPersistContext(m.admin, 'f', 'Fund I')).toEqual({ error: 'The chart of accounts could not be read: timeout' })
  })
})
