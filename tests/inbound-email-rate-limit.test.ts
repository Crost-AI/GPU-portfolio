import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

/**
 * The inbound-email webhook is called by Postmark, from Postmark's small IP pool — so a rate limit
 * keyed on the client IP alone is one 60/min budget shared by every fund on the deployment. It is
 * keyed on the recipient inbox and the IP together — the inbox alone would let anyone who knows a
 * fund's address spend Postmark's budget for it before the token is checked — falling back to the
 * IP when the payload names no inbox, with a looser per-IP ceiling over the whole webhook so
 * rotating the recipient is not unlimited.
 *
 * And the per-fund inbound address matches case-insensitively, without the address ever acting as
 * a LIKE pattern.
 */

const rateLimit = vi.fn(async (_config: { key: string; limit: number; windowSeconds: number }): Promise<Response | null> => null)
const runPipeline = vi.fn(async () => {})
let filters: { table: string; op: string; column: string; value: unknown }[] = []
let storedAddress = 'Fund-ABC@Inbound.Test'
let clientIp = '203.0.113.9'

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: (config: { key: string; limit: number; windowSeconds: number }) => rateLimit(config),
  getClientIp: () => clientIp,
}))
vi.mock('@/lib/pipeline/processEmail', () => ({ runPipeline: (...args: unknown[]) => runPipeline(...(args as [])) }))
vi.mock('@/lib/pipeline/checkFundMember', () => ({ checkFundMember: async () => ({ user_id: 'user-1', member_role: 'admin' }) }))
vi.mock('@/lib/pipeline/isAuthorizedSender', () => ({ isAuthorizedSender: async () => true }))
vi.mock('@/lib/security/scan-file', () => ({ scanFileAsync: async () => ({ safe: true }) }))

// LIKE semantics for the one ilike the route issues: `\` escapes, `%`/`_` are wildcards, and
// PostgREST reads `*` as `%`.
const likeToRegExp = (pattern: string) => new RegExp(`^${pattern.replace(/\\(.)|([%_])|([^\\%_]+)/g,
  (_m, escaped, wild, literal) => escaped ? escaped.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    : wild ? (wild === '%' ? '.*' : '.')
    : literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}$`, 'i')

function chain(table: string) {
  let rows: Record<string, unknown>[] = table === 'fund_settings'
    ? [{ fund_id: 'fund-1', postmark_inbound_address: storedAddress, postmark_webhook_token: 'tok', postmark_webhook_token_encrypted: null, encryption_key_encrypted: null }]
    : []
  const q: any = {
    select: () => q,
    insert: () => { rows = [{ id: 'email-1' }]; return q },
    update: () => q,
    eq: (column: string, value: unknown) => { filters.push({ table, op: 'eq', column, value }); return q },
    ilike: (column: string, value: string) => {
      filters.push({ table, op: 'ilike', column, value })
      rows = rows.filter(r => likeToRegExp(value.replace(/\*/g, '%')).test(String(r[column] ?? '')))
      return q
    },
    maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
    single: async () => ({ data: rows[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok),
  }
  return q
}
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: chain }) }))

import { POST } from '@/app/api/inbound-email/route'

const post = (body: string) => POST(new NextRequest('https://fund.test/api/inbound-email', {
  method: 'POST',
  headers: { authorization: 'Bearer tok', 'content-type': 'application/json' },
  body,
}))

const email = (fields: Record<string, unknown>) => JSON.stringify({ From: 'ceo@startup.test', Subject: 'Q3 update', ...fields })

beforeEach(() => {
  rateLimit.mockReset()
  rateLimit.mockImplementation(async () => null)
  runPipeline.mockClear()
  filters = []
  storedAddress = 'Fund-ABC@Inbound.Test'
  clientIp = '203.0.113.9'
})

describe('the inbound-email rate limit', () => {
  const keys = () => rateLimit.mock.calls.map(([c]) => c)

  it('is keyed on the original recipient, normalised, under a looser per-IP ceiling', async () => {
    await post(email({ OriginalRecipient: '  Fund-ABC@Inbound.Test ', To: 'someone-else@x.test' }))
    expect(keys()).toEqual([
      { key: 'inbound:to:fund-abc@inbound.test:ip:203.0.113.9', limit: 60, windowSeconds: 60 },
      { key: 'inbound:ip:203.0.113.9', limit: 600, windowSeconds: 60 },
    ])
  })

  it('falls back to To when there is no original recipient', async () => {
    await post(email({ To: 'Fund-ABC@inbound.test' }))
    expect(keys()).toEqual([
      { key: 'inbound:to:fund-abc@inbound.test:ip:203.0.113.9', limit: 60, windowSeconds: 60 },
      { key: 'inbound:ip:203.0.113.9', limit: 600, windowSeconds: 60 },
    ])
  })

  it("falls back to the caller's IP, at the tight limit, when the payload names no inbox", async () => {
    await post(email({}))
    expect(keys()).toEqual([{ key: 'inbound:ip:203.0.113.9', limit: 60, windowSeconds: 60 }])
  })

  it("gives a caller elsewhere its own bucket for an inbox, not Postmark's", async () => {
    // Before the token is checked, anyone can name a fund's inbox; they must not spend the budget
    // Postmark's real deliveries to it draw on.
    await post(email({ OriginalRecipient: 'fund-abc@inbound.test' }))
    clientIp = '198.51.100.7'
    await post(email({ OriginalRecipient: 'fund-abc@inbound.test' }))
    expect(keys().filter(c => c.limit === 60).map(c => c.key)).toEqual([
      'inbound:to:fund-abc@inbound.test:ip:203.0.113.9',
      'inbound:to:fund-abc@inbound.test:ip:198.51.100.7',
    ])
  })

  it('returns the first 429: a full inbox stops before the IP ceiling is counted', async () => {
    rateLimit.mockImplementationOnce(async () => NextResponse.json({ error: 'inbox' }, { status: 429 }))
    const res = await post(email({ OriginalRecipient: 'fund-abc@inbound.test' }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'inbox' })
    expect(keys()).toHaveLength(1)
    expect(runPipeline).not.toHaveBeenCalled()
  })

  it('refuses when the IP ceiling is full even though the inbox has room', async () => {
    rateLimit
      .mockImplementationOnce(async () => null)
      .mockImplementationOnce(async () => NextResponse.json({ error: 'ip' }, { status: 429 }))
    const res = await post(email({ OriginalRecipient: 'fund-abc@inbound.test' }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'ip' })
    expect(runPipeline).not.toHaveBeenCalled()
  })

  it('answers 200 to a malformed body and runs nothing', async () => {
    for (const body of ['{not json', 'null', '42']) {
      const res = await post(body)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    }
    expect(runPipeline).not.toHaveBeenCalled()
  })
})

describe('resolving the fund from the inbound address', () => {
  it("matches the fund's stored address whatever its case", async () => {
    await post(email({ OriginalRecipient: 'fund-abc@INBOUND.test' }))
    expect(filters).toContainEqual({ table: 'fund_settings', op: 'ilike', column: 'postmark_inbound_address', value: 'fund-abc@INBOUND.test' })
    expect(runPipeline).toHaveBeenCalledTimes(1)
    expect((runPipeline.mock.calls[0] as unknown[])[2]).toBe('fund-1')
  })

  it("escapes LIKE metacharacters, so an address can't match another fund's", async () => {
    storedAddress = 'fund_a@inbound.test'
    await post(email({ OriginalRecipient: 'fund%@inbound.test' }))
    expect(filters).toContainEqual({ table: 'fund_settings', op: 'ilike', column: 'postmark_inbound_address', value: 'fund\\%@inbound.test' })
    expect(runPipeline).not.toHaveBeenCalled()

    filters = []
    await post(email({ OriginalRecipient: 'fund_a@inbound.test' }))
    expect(filters).toContainEqual({ table: 'fund_settings', op: 'ilike', column: 'postmark_inbound_address', value: 'fund\\_a@inbound.test' })
    expect(runPipeline).toHaveBeenCalledTimes(1)
  })

  it("does not route on PostgREST's `*` wildcard", async () => {
    // PostgREST reads `*` in a like pattern as `%`; the exact comparison after the lookup refuses it.
    storedAddress = 'fund-abc@inbound.test'
    await post(email({ OriginalRecipient: '*@inbound.test' }))
    expect(runPipeline).not.toHaveBeenCalled()
  })
})
