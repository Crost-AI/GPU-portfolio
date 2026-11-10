import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Requesting membership of a fund.
 *
 * This route is deliberately ungated — the caller has no fund yet, so there is no grant to check
 * (`lib/access/route-domains.ts`). Its only authorisation is that the target fund listed the
 * caller's exact address or domain on its signup allow-list, or claims the domain as its
 * `email_domain` (lib/onboarding/joinable-funds.ts), and it takes `fundId` straight from the body.
 *
 * That combination has a hole the demo makes reachable: an anonymous visitor holds a session as
 * the shared demo account, and if that account's email domain matches a real fund, they can file
 * a join request against it. It can never become access — `fund_members_user_id_unique` means the
 * demo user already has its one row — but it puts an attacker-triggered row in an admin's
 * approval queue, which is social-engineering surface.
 *
 * The fix pinned here: someone who already belongs to ANY fund cannot request another. That is
 * the schema invariant stated in the route, rather than left to a convention about which email
 * domain the demo account happens to use.
 */

const getUser = vi.hoisted(() => vi.fn())
const from = vi.hoisted(() => vi.fn())
const rateLimit = vi.hoisted(() => vi.fn(async () => null))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from }) }))
vi.mock('@/lib/rate-limit', async importOriginal => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  rateLimit,
}))

import { POST } from '@/app/api/onboarding/join/route'

/** The caller's single fund_members row, or null when they belong to no fund. */
let membership: { fund_id: string } | null = null
/** Join requests created during the call — the thing that must not happen. */
let created: Record<string, unknown>[] = []

/** Rows of allowed_signups: each fund's signup allow-list. */
let allowList: { fund_id: string; email_pattern: string }[] = []
const FUNDS = [
  { id: 'target-fund', name: 'Real Fund', email_domain: 'example.com' },
  { id: 'other-fund', name: 'Other Fund', email_domain: 'other.com' },
]

/** A list query: records .eq/.in filters and resolves to the matching rows when awaited. */
function listQuery(rows: Record<string, unknown>[]) {
  const preds: ((r: Record<string, unknown>) => boolean)[] = []
  const chain: any = {
    select: () => chain,
    eq: (col: string, val: unknown) => { preds.push(r => r[col] === val); return chain },
    in: (col: string, vals: unknown[]) => { preds.push(r => vals.includes(r[col])); return chain },
    not: (col: string) => { preds.push(r => r[col] != null); return chain },
    then: (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows.filter(r => preds.every(p => p(r))), error: null }).then(resolve),
  }
  return chain
}

function stub() {
  from.mockImplementation((table: string) => {
    if (table === 'funds') return listQuery(FUNDS)
    if (table === 'allowed_signups') return listQuery(allowList)
    if (table === 'fund_members') {
      // The filters matter here: the bug being fixed is precisely that the route scoped this
      // lookup to the TARGET fund, so a membership of some other fund was invisible to it. A
      // stub that ignored .eq() would hide the hole instead of reproducing it.
      const filters: Record<string, string> = {}
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: string) => {
          filters[col] = val
          return chain
        },
        maybeSingle: async () => {
          if (!membership) return { data: null, error: null }
          if (filters.fund_id && filters.fund_id !== membership.fund_id) {
            return { data: null, error: null }
          }
          return { data: { id: 'm1', ...membership }, error: null }
        },
      }
      return chain
    }
    // fund_join_requests
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: async () => ({ data: null, error: null }),
      insert: async (row: Record<string, unknown>) => {
        created.push(row)
        return { error: null }
      },
    }
    return chain
  })
}

const req = (fundId: string) =>
  ({
    json: async () => ({ fundId }),
    headers: new Headers({ 'x-real-ip': '203.0.113.7' }),
  }) as any

beforeEach(() => {
  vi.clearAllMocks()
  membership = null
  created = []
  allowList = []
  getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'someone@example.com' } } })
  rateLimit.mockResolvedValue(null)
  stub()
})

describe('POST /api/onboarding/join', () => {
  it('refuses a caller who already belongs to a different fund', async () => {
    // The demo case: a shared demo account whose email domain collides with a real fund.
    membership = { fund_id: 'demo-fund' }
    const res = await POST(req('target-fund'))
    expect(res.status).toBe(403)
    expect(created).toHaveLength(0)
  })

  it('refuses a caller who already belongs to the target fund', async () => {
    membership = { fund_id: 'target-fund' }
    const res = await POST(req('target-fund'))
    expect(res.status).toBe(400)
    expect(created).toHaveLength(0)
  })

  it('lets a caller with no fund request one when the email domain matches', async () => {
    const res = await POST(req('target-fund'))
    expect(res.status).toBe(200)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ fund_id: 'target-fund', user_id: 'u1', status: 'pending' })
  })

  it('still refuses when the email domain does not match', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'someone@elsewhere.com' } } })
    const res = await POST(req('target-fund'))
    expect(res.status).toBe(403)
    expect(created).toHaveLength(0)
  })

  it('lets a specific address the fund listed request it, whatever its domain', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'Partner@Gmail.com' } } })
    allowList = [{ fund_id: 'target-fund', email_pattern: 'partner@gmail.com' }]
    const res = await POST(req('target-fund'))
    expect(res.status).toBe(200)
    expect(created).toHaveLength(1)
  })

  it('lets a domain the fund listed request it', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'someone@elsewhere.com' } } })
    allowList = [{ fund_id: 'target-fund', email_pattern: '*@elsewhere.com' }]
    expect((await POST(req('target-fund'))).status).toBe(200)
  })

  it('refuses an address that a different fund listed', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'partner@gmail.com' } } })
    allowList = [{ fund_id: 'other-fund', email_pattern: 'partner@gmail.com' }]
    expect((await POST(req('target-fund'))).status).toBe(403)
    expect(created).toHaveLength(0)
  })

  it('never matches a consumer domain through a wildcard', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u1', email: 'stranger@gmail.com' } } })
    allowList = [{ fund_id: 'target-fund', email_pattern: '*@gmail.com' }]
    expect((await POST(req('target-fund'))).status).toBe(403)
    expect(created).toHaveLength(0)
  })
})
