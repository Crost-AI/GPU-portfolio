import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { adminOnlyRule, adminOnlyToolLabel } from '@/lib/access/admin-only'
import { ROUTE_DOMAINS } from '@/lib/access/route-domains'
import { isDraftOnlyCall } from '@/lib/agent/dispatch'

// Who can see a capital call notice before it is issued: fund members with LP capital, through the
// gated route and tools, and nobody else. Not an LP, and not a member from the browser console.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const allSql = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).map(f => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n')

describe('capital_call_notice_drafts reach', () => {
  it('is granted to service_role alone, with RLS on and no policy', () => {
    const grants = [...allSql.matchAll(/grant\s+([^;]+?)\s+on\s+(?:table\s+)?public\.capital_call_notice_drafts\s+to\s+([^;]+);/gi)]
    expect(grants.length).toBeGreaterThan(0)
    for (const g of grants) expect(g[2].split(',').map(r => r.trim().toLowerCase())).toEqual(['service_role'])
    expect(allSql).toMatch(/alter table public\.capital_call_notice_drafts enable row level security/i)
    expect(allSql).not.toMatch(/create policy[^;]+on public\.capital_call_notice_drafts/i)
  })

  it('is never read by the LP portal or the investor connector', () => {
    const hits = execSync(
      'grep -rl "capital_call_notice_drafts\\|call-notice-drafts" app/portal app/api/portal lib/portal || true',
      { encoding: 'utf8' },
    ).trim()
    expect(hits).toBe('')
  })

  it('is served through lp_capital routes, and only an admin approves', () => {
    expect(ROUTE_DOMAINS['api/accounting/call-notices']).toEqual({ domain: 'lp_capital' })
    expect(ROUTE_DOMAINS['api/accounting/call-notices/pdf']).toEqual({ domain: 'lp_capital' })
    expect(adminOnlyRule('api/accounting/call-notices', 'POST', { action: 'approve' })).toBeDefined()
    expect(adminOnlyRule('api/accounting/call-notices', 'POST', { action: 'draft' })).toBeUndefined()
    expect(adminOnlyToolLabel('approve_capital_call_notice', {})).toBeDefined()
    expect(adminOnlyRule('api/accounting/vehicle-settings', 'PATCH', { callNoticeDays: 10 })).toBeDefined()
    expect(adminOnlyRule('api/accounting/vehicle-settings', 'PATCH', { wireInstructions: 'x' })).toBeUndefined()
  })

  it('drafts from chat run directly; approval is the write that stages', () => {
    expect(isDraftOnlyCall({ name: 'draft_capital_call_notice' }, {})).toBe(true)
    expect(isDraftOnlyCall({ name: 'approve_capital_call_notice' }, {})).toBe(false)
  })
})
