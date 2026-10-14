import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// diligence_memo_draft_flags is read only by the admin-only analytics route, with the service-role
// key. A grant to anon/authenticated would hand every draft's pipeline state to any fund member's
// browser, past that admin check — so, like the tax tables (tax-data-api-grants.test.ts), pin it.
const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const sql = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).map(f => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n')

describe('diligence_memo_draft_flags grants', () => {
  it('is revoked from anon/authenticated and granted to service_role alone', () => {
    expect(sql).toMatch(/revoke all on public\.diligence_memo_draft_flags from anon, authenticated;/i)
    const grants = [...sql.matchAll(/grant\s+[^;]*?\s+on\s+(?:table\s+)?(?:public\.)?diligence_memo_draft_flags\s+to\s+([^;]+);/gi)]
      .flatMap(m => m[1].split(',').map(r => r.trim().toLowerCase()))
    expect(grants).toEqual(['service_role'])
  })
})
