import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/oauth/enabled', () => ({ agentApiEnabled: vi.fn(async (_admin: unknown, fundId: string) => fundId !== 'f-off') }))

import { loadPool, masterAdminEmails, matchFund, poolFunds, type MasterAdminPool } from './master-admin'

const ROWS = [
  { user_id: 'u-northwind', email: 't@northwind.example', fund_id: 'f-northwind', fund_name: 'Northwind Holdings' },
  { user_id: 'u-lac', email: 't@ashgrove.example', fund_id: 'f-lac', fund_name: 'Ashgrove Capital' },
]

function fakeAdmin(rows: unknown[], active: string | null = null) {
  return {
    rpc: vi.fn(async () => ({ data: rows, error: null })),
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: active ? { fund_id: active } : null }) }) }) }),
    }),
  } as any
}

afterEach(() => { delete process.env.MASTER_ADMIN_EMAILS })

describe('masterAdminEmails', () => {
  it('splits, trims, lower-cases and dedupes', () => {
    expect(masterAdminEmails(' A@x.com, b@y.com;a@X.com\nnot-an-email ')).toEqual(['a@x.com', 'b@y.com'])
    expect(masterAdminEmails(undefined)).toEqual([])
  })
})

describe('poolFunds', () => {
  it('keeps one acting admin per fund, chosen stably by email', () => {
    const funds = poolFunds([...ROWS, { user_id: 'u-a', email: 'a@northwind.example', fund_id: 'f-northwind', fund_name: 'Northwind Holdings' }])
    expect(funds.map(f => [f.fundName, f.email])).toEqual([
      ['Northwind Holdings', 'a@northwind.example'],
      ['Ashgrove Capital', 't@ashgrove.example'],
    ])
  })
})

describe('loadPool', () => {
  const owner = { userId: 'u-lac', fundId: 'f-lac', clientId: 'claude' }

  it('is off when the variable lists fewer than two addresses', async () => {
    process.env.MASTER_ADMIN_EMAILS = 't@ashgrove.example'
    expect(await loadPool(fakeAdmin(ROWS), owner)).toBeNull()
  })

  it('is off for an owner who is not a listed admin of their own fund', async () => {
    process.env.MASTER_ADMIN_EMAILS = 't@ashgrove.example,t@northwind.example'
    expect(await loadPool(fakeAdmin(ROWS), { ...owner, userId: 'someone-else' })).toBeNull()
  })

  it('starts on the authorizing fund, then follows the stored choice', async () => {
    process.env.MASTER_ADMIN_EMAILS = 't@ashgrove.example,t@northwind.example'
    expect((await loadPool(fakeAdmin(ROWS), owner))?.activeFundId).toBe('f-lac')
    expect((await loadPool(fakeAdmin(ROWS, 'f-northwind'), owner))?.activeFundId).toBe('f-northwind')
  })

  it('ignores a stored fund that has left the pool', async () => {
    process.env.MASTER_ADMIN_EMAILS = 't@ashgrove.example,t@northwind.example'
    expect((await loadPool(fakeAdmin(ROWS, 'f-gone'), owner))?.activeFundId).toBe('f-lac')
  })

  it('leaves out a fund with agent access switched off', async () => {
    process.env.MASTER_ADMIN_EMAILS = 't@ashgrove.example,t@northwind.example,t@off.com'
    const rows = [...ROWS, { user_id: 'u-off', email: 't@off.com', fund_id: 'f-off', fund_name: 'Off Fund' }]
    const pool = await loadPool(fakeAdmin(rows), owner)
    expect(pool?.funds.map(f => f.fundId)).toEqual(['f-northwind', 'f-lac'])
  })
})

describe('matchFund', () => {
  const pool: MasterAdminPool = { homeUserId: 'u-lac', clientId: 'c', activeFundId: 'f-lac', funds: poolFunds(ROWS) }

  it('matches by id, exact name or an unambiguous part', () => {
    expect((matchFund(pool, 'f-northwind') as any).fundId).toBe('f-northwind')
    expect((matchFund(pool, 'ashgrove capital') as any).fundId).toBe('f-lac')
    expect((matchFund(pool, 'northwind') as any).fundId).toBe('f-northwind')
  })

  it('refuses with the choices when nothing or too much matches', () => {
    expect(matchFund(pool, 'nope')).toMatch(/Choose from: Northwind Holdings, Ashgrove Capital/)
    expect(matchFund(pool, 'o')).toMatch(/more than one fund/)
    expect(matchFund(pool, '')).toMatch(/Name the fund/)
  })
})
