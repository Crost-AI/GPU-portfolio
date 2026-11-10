import { describe, expect, it } from 'vitest'
import { GPU_SPV_CHART, assetAccountCode } from '@/lib/accounting/chart'
import type { Account, Posting } from '@/lib/accounting/types'
import { gpuBookNav } from './book-nav'

const A1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const accounts: Account[] = [
  ...GPU_SPV_CHART,
  { code: assetAccountCode('1600', A1), name: 'cost', type: 'asset', subtype: 'fixed_asset' },
  { code: assetAccountCode('1650', A1), name: 'acc', type: 'asset', subtype: 'accumulated_depreciation' },
  { code: '2900-mancoabc', name: 'Due to Manco', type: 'liability', subtype: 'intercompany_payable' },
].map(a => ({ id: a.code, fundId: 'f1', code: a.code, name: a.name, type: a.type as Account['type'], subtype: a.subtype ?? null, lpEntityId: null, companyId: null }))
const post = (legs: [string, number][]): Posting[] => legs.map(([accountId, amount]) => ({ accountId, amount, currency: 'USD' }))

describe('gpuBookNav: cash − reserve − what is owed + equipment at NBV', () => {
  it('reads the ledger as Karl defines it', () => {
    const postings = post([
      ['1000', 300_000], ['1050', 20_000],                                         // cash and the reserve account
      [assetAccountCode('1600', A1), 410_000], [assetAccountCode('1650', A1), -82_000], // NBV 328,000
      ['2000', -15_000], ['2100', -2_500], ['2300', -40_000], ['2900-mancoabc', -1_200], // owed 58,700
      ['1150', 66_000], ['1500', 3_000],                                           // receivable and prepaid: left out
      ['3100', -669_300],
    ])
    expect(gpuBookNav(accounts, postings, 25_000)).toEqual({
      cash: 320_000, reserve: 25_000, owed: 58_700, equipment: 328_000, bookNav: 320_000 - 25_000 - 58_700 + 328_000,
    })
  })

  it('a debit balance on a payable is not owed, and the reserve is never negative', () => {
    const nav = gpuBookNav(accounts, post([['1000', 1_000], ['2000', 500]]), -10)
    expect(nav).toMatchObject({ owed: 0, reserve: 0, bookNav: 1_000 })
  })
})
