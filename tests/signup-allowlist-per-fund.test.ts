import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync } from 'fs'
import { PUBLIC_EMAIL_DOMAINS, PUBLIC_EMAIL_FAMILIES } from '@/lib/onboarding/wizard'
import { memoryAdmin } from './helpers/memory-admin'

/**
 * Each fund keeps its own signup allow-list. The table once had no fund, so every fund's admins
 * read, added to and deleted from one shared list.
 */

let mem: ReturnType<typeof memoryAdmin>
let userId = 'admin-a'

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: userId } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => mem.admin }))

import { GET, POST } from '@/app/api/settings/whitelist/route'
import { DELETE } from '@/app/api/settings/whitelist/[id]/route'

beforeEach(() => {
  userId = 'admin-a'
  mem = memoryAdmin({
    fund_members: [
      { fund_id: 'fund-a', user_id: 'admin-a', role: 'admin' },
      { fund_id: 'fund-b', user_id: 'admin-b', role: 'admin' },
    ],
    allowed_signups: [
      { id: 'a1', fund_id: 'fund-a', email_pattern: '*@alpha.test', created_at: '2026-01-01' },
      { id: 'b1', fund_id: 'fund-b', email_pattern: '*@beta.test', created_at: '2026-01-01' },
    ],
  }, { unique: [{ table: 'allowed_signups', key: r => `${r.fund_id}|${r.email_pattern}` }] })
})

const post = (emailPattern: string) => POST(new NextRequest('http://x/api/settings/whitelist', { method: 'POST', body: JSON.stringify({ emailPattern }) }))

describe('the signup allow-list is per fund', () => {
  it("lists only the caller's fund", async () => {
    const res = await GET()
    expect((await res.json()).entries.map((e: any) => e.email_pattern)).toEqual(['*@alpha.test'])
    userId = 'admin-b'
    expect((await (await GET()).json()).entries.map((e: any) => e.email_pattern)).toEqual(['*@beta.test'])
  })

  it("adds to the caller's fund, and two funds may allow the same domain", async () => {
    expect((await post('*@beta.test')).status).toBe(200)
    expect(mem.tables.allowed_signups.filter(r => r.email_pattern === '*@beta.test').map(r => r.fund_id).sort()).toEqual(['fund-a', 'fund-b'])
    expect((await post('*@beta.test')).status).toBe(409)
  })

  it("cannot delete another fund's entry", async () => {
    await DELETE(new NextRequest('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'b1' }) })
    expect(mem.tables.allowed_signups.map(r => r.id)).toContain('b1')
    await DELETE(new NextRequest('http://x', { method: 'DELETE' }), { params: Promise.resolve({ id: 'a1' }) })
    expect(mem.tables.allowed_signups.map(r => r.id)).not.toContain('a1')
  })

  it('the migration scopes entries to a fund and keeps the signup gate deployment-wide', () => {
    const sql = readFileSync('supabase/migrations/20261104120200_allowed_signups_per_fund.sql', 'utf8')
    expect(sql).toMatch(/add column if not exists fund_id uuid references public\.funds\(id\) on delete cascade/)
    expect(sql).toMatch(/unique nulls not distinct \(fund_id, email_pattern\)/)
    expect(sql).not.toMatch(/create or replace function/i) // the gate (hook_before_user_created) is untouched
  })

  // Crost #130: the backfill gives a row a fund only when its owner is unambiguous, never copies a
  // row to a second fund, and never infers a fund from its members' own addresses.
  it('the backfill assigns only unambiguous owners and copies nothing', () => {
    const sql = readFileSync('supabase/migrations/20261104120200_allowed_signups_per_fund.sql', 'utf8')
    const backfill = sql.slice(sql.indexOf('-- Backfill:'))
    expect(backfill).not.toMatch(/insert\s+into\s+public\.allowed_signups/i)
    expect(backfill).not.toMatch(/split_part\(lower\(u\.email\)/i)
    expect(backfill.match(/having count\(distinct (fm\.fund_id|f\.id)\) = 1/g)).toHaveLength(2)
    // The consumer mailbox list matches the app's (lib/onboarding/wizard.ts), so a wildcard on a
    // consumer domain is never given to the fund that happens to claim it.
    const listed = new Set(Array.from(backfill.match(/<> all \(array\[([\s\S]*?)\]\)/)![1].matchAll(/'([^']+)'/g), m => m[1]))
    expect(listed).toEqual(PUBLIC_EMAIL_DOMAINS)
    expect(backfill).toContain(`!~ '${PUBLIC_EMAIL_FAMILIES.source}'`)
  })
})
