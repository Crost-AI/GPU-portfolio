import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { linkIntercompanyAccount } from '@/lib/accounting/intercompany'

// Re-pointing a counterparty's Due-from account unlinks the old one only when it holds no postings.

const world = () => memoryAdmin({
  chart_of_accounts: [
    { id: 'old', fund_id: 'f', vehicle_id: 'v', code: '1300', name: 'Due from Fund I', type: 'asset', subtype: 'receivable', counterparty_vehicle_id: 'other' },
    { id: 'new', fund_id: 'f', vehicle_id: 'v', code: '1310', name: 'Due from, new', type: 'asset', subtype: 'receivable', counterparty_vehicle_id: null },
  ],
  journal_postings: [],
})
const linkOf = (m: ReturnType<typeof memoryAdmin>, id: string) => m.tables.chart_of_accounts.find(a => a.id === id)!.counterparty_vehicle_id

describe('linkIntercompanyAccount', () => {
  it('moves the link when the old account holds nothing', async () => {
    const m = world()
    expect(await linkIntercompanyAccount(m.admin, 'f', 'v', 'new', 'other')).toMatchObject({ ok: true })
    expect(linkOf(m, 'old')).toBeNull()
    expect(linkOf(m, 'new')).toBe('other')
  })

  it('refuses when the old account holds postings', async () => {
    const m = world()
    m.tables.journal_postings.push({ id: 'p', fund_id: 'f', account_id: 'old', book: 'actual', amount: 1 })
    expect(await linkIntercompanyAccount(m.admin, 'f', 'v', 'new', 'other')).toHaveProperty('error')
    expect(linkOf(m, 'old')).toBe('other')
  })

  it('a failed count is not "no postings": nothing is unlinked (Bugbot on #133)', async () => {
    const m = world()
    m.failNext('journal_postings', 'select', 'boom')
    const out = await linkIntercompanyAccount(m.admin, 'f', 'v', 'new', 'other')
    expect(out).toMatchObject({ error: expect.stringContaining('boom') })
    expect(linkOf(m, 'old')).toBe('other')
    expect(linkOf(m, 'new')).toBeNull()
  })
})
