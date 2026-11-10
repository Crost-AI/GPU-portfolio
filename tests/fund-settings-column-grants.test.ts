import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

// Members read fund_settings through column grants that leave out the secrets (every *_encrypted
// column, the legacy plaintext Postmark webhook token and the deal-submission token hash). Column
// grants do not follow new columns, so every later migration that adds a column must re-run
// public.grant_fund_settings_member_columns(), or members' own reads of that column are refused.
// Pinned by reading the SQL, the same way db-security-hardening.test.ts does.

const ROOT = process.cwd()
const DIRS = ['migrations', 'pending-deploy'].map(d => join(ROOT, 'supabase', d))
const files = DIRS.filter(existsSync).flatMap(dir =>
  readdirSync(dir).filter(f => f.endsWith('.sql')).map(f => ({ dir, name: f, sql: readFileSync(join(dir, f), 'utf8') })),
)
const norm = (s: string) => s.replace(/--.*$/gm, '').replace(/\s+/g, ' ').toLowerCase()
const DEFINES = /create\s+(?:or\s+replace\s+)?function\s+public\.grant_fund_settings_member_columns\s*\(/i

describe('fund_settings secrets are not readable by members', () => {
  const defining = files.filter(f => DEFINES.test(f.sql))

  it('one file defines grant_fund_settings_member_columns and runs it', () => {
    expect(defining).toHaveLength(1)
    expect(norm(defining[0].sql)).toContain('select public.grant_fund_settings_member_columns();')
  })

  it('grants every column except the secrets, after revoking the table-wide SELECT', () => {
    const sql = norm(defining[0].sql)
    expect(sql).toContain("right(column_name, 10) <> '_encrypted'")
    expect(sql).toContain("column_name not in ('postmark_webhook_token', 'deal_submission_token')")
    expect(sql).toContain('revoke select on public.fund_settings from anon, authenticated;')
    expect(sql).toContain("grant select (%s) on public.fund_settings to authenticated")
  })

  it('is not callable over the Data API', () => {
    expect(norm(defining[0].sql)).toContain(
      'revoke execute on function public.grant_fund_settings_member_columns() from public, anon, authenticated;',
    )
  })

  it('every migration after it that adds a fund_settings column re-runs the grants', () => {
    const def = defining[0]
    // Still staged: nothing in supabase/migrations comes after it yet.
    if (!def.dir.endsWith('migrations')) return
    const later = files
      .filter(f => f.dir === def.dir && f.name > def.name)
      .filter(f => /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?fund_settings\b[^;]*\badd\s+column\b/i.test(f.sql))
    for (const f of later) {
      expect(norm(f.sql), `${f.name} adds a fund_settings column without re-running the member grants`)
        .toContain('select public.grant_fund_settings_member_columns();')
    }
  })
})
