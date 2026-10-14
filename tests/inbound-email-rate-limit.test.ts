import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

/**
 * The inbound-email webhook is called by Postmark, from Postmark's small IP pool — so a tight rate
 * limit keyed on the client IP is one 60/min budget shared by every fund on the deployment. A
 * coarse per-IP ceiling (600/min) runs first, before the body is read, so malformed requests are
 * bounded too; the 60/min is per fund, counted only once the webhook token has resolved the fund,
 * so a caller without the token can only ever spend the ceiling.
 *
 * And the per-fund inbound address matches case-insensitively, without the address ever acting as
 * a LIKE pattern.
 */

const rateLimit = vi.fn(async (_config: { key: string; limit: number; windowSeconds: number }): Promise<Response | null> => null)
const runPipeline = vi.fn(async () => {})
let filters: { table: string; op: string; column: string; value: unknown }[] = []
let storedAddress = 'Fund-ABC@Inbound.Test'
let otherFunds: { fund_id: string; address: string }[] = []
let clientIp = '203.0.113.9'
let inserts = 0

vi.mock('@/lib/rate-limit', () => ({
  rateLimit: (config: { key: string; limit: number; windowSeconds: number }) => rateLimit(config),
  getClientIp: () => clientIp,
}))
vi.mock('@/lib/pipeline/processEmail', () => ({ runPipeline: (...args: unknown[]) => runPipeline(...(args as [])) }))
vi.mock('@/lib/pipeline/checkFundMember', () => ({ checkFundMember: async () => ({ user_id: 'user-1', member_role: 'admin' }) }))
vi.mock('@/lib/pipeline/isAuthorizedSender', () => ({ isAuthorizedSender: async () => true }))
vi.mock('@/lib/security/scan-file', () => ({ scanFileAsync: async () => ({ safe: true }) }))

// LIKE semantics for the one ilike the route issues, as PostgREST applies it per the review: the
// route's `\` escapes are dropped, so `%`/`_` stay wildcards, and `*` reads as `%`.
const likeToRegExp = (pattern: string) => new RegExp(`^${pattern.replace(/\\/g, '').replace(/\*/g, '%').replace(/([%_])|([^%_]+)/g,
  (_m, wild, literal) => wild ? (wild === '%' ? '.*' : '.') : literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))}$`, 'i')

const settingsRow = (fund_id: string, address: string, token: string) =>
  ({ fund_id, postmark_inbound_address: address, postmark_webhook_token: token, postmark_webhook_token_encrypted: null, encryption_key_encrypted: null })

function chain(table: string) {
  let rows: Record<string, unknown>[] = table === 'fund_settings'
    ? [...otherFunds.map(f => settingsRow(f.fund_id, f.address, `tok-${f.fund_id}`)), settingsRow('fund-1', storedAddress, 'tok')]
    : []
  const q: any = {
    select: () => q,
    insert: () => { inserts++; rows = [{ id: 'email-1' }]; return q },
    update: () => q,
    limit: () => q,
    eq: (column: string, value: unknown) => { filters.push({ table, op: 'eq', column, value }); return q },
    ilike: (column: string, value: string) => {
      filters.push({ table, op: 'ilike', column, value })
      rows = rows.filter(r => likeToRegExp(value).test(String(r[column] ?? '')))
      return q
    },
    maybeSingle: async () => rows.length > 1
      ? { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } }
      : { data: rows[0] ?? null, error: null },
    single: async () => ({ data: rows[0] ?? null, error: null }),
    then: (ok: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(ok),
  }
  return q
}
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: chain }) }))

import { POST } from '@/app/api/inbound-email/route'

const post = (body: string, token = 'tok') => POST(new NextRequest('https://fund.test/api/inbound-email', {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body,
}))

const email = (fields: Record<string, unknown>) => JSON.stringify({ From: 'ceo@startup.test', Subject: 'Q3 update', ...fields })

beforeEach(() => {
  rateLimit.mockReset()
  rateLimit.mockImplementation(async () => null)
  runPipeline.mockClear()
  filters = []
  storedAddress = 'Fund-ABC@Inbound.Test'
  otherFunds = []
  clientIp = '203.0.113.9'
  inserts = 0
})

describe('the inbound-email rate limit', () => {
  const keys = () => rateLimit.mock.calls.map(([c]) => c)
  const CEILING = { key: 'inbound:ip:203.0.113.9', limit: 600, windowSeconds: 60 }
  const FUND = { key: 'inbound:fund:fund-1', limit: 60, windowSeconds: 60 }
  const refuse = (error: string) => async () => NextResponse.json({ error }, { status: 429 })

  it('checks the per-IP ceiling, then — once the token resolves the fund — the per-fund bucket', async () => {
    const res = await post(email({ OriginalRecipient: 'fund-abc@inbound.test' }))
    expect(res.status).toBe(200)
    expect(keys()).toEqual([CEILING, FUND])
    expect(runPipeline).toHaveBeenCalledTimes(1)
  })

  it('keys the fund bucket on the fund, not on how the recipient was written', async () => {
    await post(email({ To: 'FUND-ABC@inbound.test' }))
    await post(email({ OriginalRecipient: ' fund-abc@INBOUND.test', To: 'someone-else@x.test' }))
    expect(keys().filter(c => c.limit === 60)).toEqual([FUND])
  })

  it("never counts a fund's bucket for a caller without its token", async () => {
    await post(email({ OriginalRecipient: 'fund-abc@inbound.test' }), 'wrong')
    await post(email({ OriginalRecipient: 'fund-abc@inbound.test' }), '')
    await post(email({ OriginalRecipient: 'nobody@inbound.test' }))
    await post(email({}))
    expect(keys()).toEqual([CEILING, CEILING, CEILING, CEILING])
    expect(runPipeline).not.toHaveBeenCalled()
  })

  it('returns the first 429: a full ceiling stops before the body is read or the fund counted', async () => {
    rateLimit.mockImplementationOnce(refuse('ip'))
    const res = await post(email({ OriginalRecipient: 'fund-abc@inbound.test' }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'ip' })
    expect(keys()).toEqual([CEILING])
    expect(runPipeline).not.toHaveBeenCalled()
  })

  it("answers a spent fund bucket with its 429, before anything is stored", async () => {
    rateLimit.mockImplementationOnce(async () => null).mockImplementationOnce(refuse('fund'))
    const res = await post(email({ OriginalRecipient: 'fund-abc@inbound.test' }))
    expect(res.status).toBe(429)
    expect(await res.json()).toEqual({ error: 'fund' })
    expect(keys()).toEqual([CEILING, FUND])
    expect(inserts).toBe(0)
    expect(runPipeline).not.toHaveBeenCalled()
  })

  const MALFORMED = [
    '{not json', 'null', '42',
    // An address field that is there but not a string.
    email({ To: 42 }), email({ OriginalRecipient: {} }), email({ OriginalRecipient: ['fund-abc@inbound.test'] }),
    email({ OriginalRecipient: 'fund-abc@inbound.test', From: { Email: 'ceo@startup.test' } }),
  ]

  it('answers 200 to a malformed body and runs nothing, having counted it against the ceiling', async () => {
    for (const body of MALFORMED) {
      const res = await post(body)
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true })
    }
    expect(keys()).toEqual(MALFORMED.map(() => CEILING))
    expect(runPipeline).not.toHaveBeenCalled()
  })

  it('throttles malformed requests once the ceiling is spent, without reading the body', async () => {
    rateLimit.mockImplementation(refuse('ip'))
    for (const body of MALFORMED) {
      const req = new NextRequest('https://fund.test/api/inbound-email', { method: 'POST', body })
      const json = vi.spyOn(req, 'json')
      const res = await POST(req)
      expect(res.status).toBe(429)
      expect(json).not.toHaveBeenCalled()
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

  it("doesn't let an address act as a pattern on another fund's", async () => {
    storedAddress = 'fund_a@inbound.test'
    await post(email({ OriginalRecipient: 'fund%@inbound.test' }))
    expect(filters).toContainEqual({ table: 'fund_settings', op: 'ilike', column: 'postmark_inbound_address', value: 'fund\\%@inbound.test' })
    expect(runPipeline).not.toHaveBeenCalled()

    filters = []
    await post(email({ OriginalRecipient: 'fund_a@inbound.test' }))
    expect(filters).toContainEqual({ table: 'fund_settings', op: 'ilike', column: 'postmark_inbound_address', value: 'fund\\_a@inbound.test' })
    expect(runPipeline).toHaveBeenCalledTimes(1)
  })

  it('picks the exact address when the pattern matches several funds', async () => {
    // `_` stays a wildcard once PostgREST drops the escape: both rows come back, the other first.
    // maybeSingle would have errored on the second row and dropped the message.
    storedAddress = 'fund_a@inbound.test'
    otherFunds = [{ fund_id: 'fund-2', address: 'fundxa@inbound.test' }]
    const res = await post(email({ OriginalRecipient: 'FUND_A@inbound.test' }))
    expect(res.status).toBe(200)
    expect(runPipeline).toHaveBeenCalledTimes(1)
    expect((runPipeline.mock.calls[0] as unknown[])[2]).toBe('fund-1')
  })

  it('routes nowhere, without failing, when a wildcard matches several funds and none exactly', async () => {
    otherFunds = [{ fund_id: 'fund-2', address: 'b@inbound.test' }, { fund_id: 'fund-3', address: 'c@inbound.test' }]
    const res = await post(email({ OriginalRecipient: '%@inbound.test' }))
    expect(res.status).toBe(200)
    expect(runPipeline).not.toHaveBeenCalled()
  })

  it("does not route on PostgREST's `*` wildcard", async () => {
    // PostgREST reads `*` in a like pattern as `%`; the exact comparison after the lookup refuses it.
    storedAddress = 'fund-abc@inbound.test'
    await post(email({ OriginalRecipient: '*@inbound.test' }))
    expect(runPipeline).not.toHaveBeenCalled()
  })
})
