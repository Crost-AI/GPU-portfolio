import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'

// Three database-level guarantees that are easy to lose to a later `create or replace` or a
// "tidy-up" migration, pinned by reading the migration SQL (same shape as
// tax-data-api-grants.test.ts and saved-dashboards-grants.test.ts):
//
//  1. The signup hook is not on the Data API. A `revoke ... from public` alone leaves Supabase's
//     direct default grants to anon/authenticated in place, so the hook was an oracle for which
//     emails are invited LPs or whitelisted GPs.
//  2. A report shared with investors cannot gain positions (the lock covers INSERT) and its rows
//     cannot be re-pointed at another entity.
//  3. The audit tables are append-only for service_role too, TRUNCATE included.

const ROOT = process.cwd()
const MIGRATIONS = join(ROOT, 'supabase', 'migrations')
const files = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort()
const read = (f: string) => readFileSync(join(MIGRATIONS, f), 'utf8')
/** Every migration, in the order `supabase db push` applies them. */
const sql = files.map(read).join('\n')
const norm = (s: string) => s.replace(/\s+/g, ' ').toLowerCase()

/** The body of the LAST `create [or replace] function public.<name>` — the one in force. */
function latestFunction(name: string): string {
  const re = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$\\$([\\s\\S]*?)\\$\\$`, 'gi')
  const all = [...sql.matchAll(re)]
  expect(all.length, `${name} is never defined`).toBeGreaterThan(0)
  return all.at(-1)![1]
}

/** The LAST `create trigger <name> ... ;` — the one in force. */
function latestTrigger(name: string): string {
  const all = [...sql.matchAll(new RegExp(`create\\s+trigger\\s+${name}\\b[^;]*;`, 'gi'))]
  expect(all.length, `${name} is never created`).toBeGreaterThan(0)
  return norm(all.at(-1)![0])
}

/** Roles each `revoke <privs> on <object> from <roles>;` names, across the history. */
function revokedRoles(privs: RegExp, object: RegExp): Set<string> {
  const out = new Set<string>()
  for (const m of sql.matchAll(/\brevoke\s+([^;]*?)\s+on\s+([^;]*?)\s+from\s+([^;]+);/gi)) {
    if (!privs.test(m[1]) || !object.test(m[2])) continue
    for (const r of m[3].split(',')) out.add(r.trim().toLowerCase())
  }
  return out
}

describe('hook_before_user_created is callable by Supabase Auth only', () => {
  const HOOK = /function\s+public\.hook_before_user_created\s*\(\s*jsonb\s*\)/i

  it('revokes EXECUTE from public, anon AND authenticated', () => {
    const roles = revokedRoles(/execute|all/i, HOOK)
    for (const r of ['public', 'anon', 'authenticated']) expect(roles.has(r), `not revoked from ${r}`).toBe(true)
  })

  it('is granted to supabase_auth_admin and to no browser role', () => {
    const grants = [...sql.matchAll(/\bgrant\s+execute\s+on\s+function\s+public\.hook_before_user_created\s*\([^)]*\)\s+to\s+([^;]+);/gi)]
    expect(grants.length).toBeGreaterThan(0)
    for (const g of grants) {
      const roles = g[1].split(',').map(r => r.trim().toLowerCase())
      expect(roles).toContain('supabase_auth_admin')
      expect(roles).not.toContain('anon')
      expect(roles).not.toContain('authenticated')
    }
  })

  it('is revoked AFTER its latest definition (create or replace keeps privileges, but a drop would not)', () => {
    const lastDef = Math.max(...files.map((f, i) => (/create\s+(or\s+replace\s+)?function\s+public\.hook_before_user_created/i.test(read(f)) ? i : -1)))
    const lastRevoke = Math.max(...files.map((f, i) =>
      (/revoke\s+execute\s+on\s+function\s+public\.hook_before_user_created\s*\(\s*jsonb\s*\)\s+from\s+[^;]*\banon\b[^;]*\bauthenticated\b/i.test(read(f)) ? i : -1)))
    expect(lastRevoke).toBeGreaterThanOrEqual(lastDef)
  })

  it('leaves the RLS helpers callable by authenticated (policies run as the caller)', () => {
    for (const fn of ['get_my_fund_ids', 'is_fund_admin', 'is_fund_writer']) {
      expect(revokedRoles(/execute|all/i, new RegExp(`function\\s+public\\.${fn}\\s*\\(`, 'i')).has('authenticated'), fn).toBe(false)
    }
  })
})

describe('a shared LP report is locked against inserts and re-pointing', () => {
  it('the lock trigger fires before insert, update and delete', () => {
    const t = latestTrigger('lp_investments_locked_when_shared')
    expect(t).toMatch(/before insert or update or delete on public\.lp_investments/)
    expect(t).toMatch(/for each row/)
  })

  it('checks the NEW report on insert and update, not only the old one', () => {
    const body = norm(latestFunction('lp_investments_locked_when_shared'))
    expect(body).toMatch(/tg_op = 'insert'/)
    expect(body).toContain('public.lp_report_is_shared(new.snapshot_id)')
    expect(body).toContain('public.lp_report_is_shared(old.snapshot_id)')
  })

  it('refuses a change of entity, report or fund on a shared row', () => {
    const body = norm(latestFunction('lp_investments_locked_when_shared'))
    expect(body).toContain('new.entity_id is distinct from old.entity_id')
    expect(body).toContain('new.snapshot_id is distinct from old.snapshot_id')
    expect(body).toContain('new.fund_id is distinct from old.fund_id')
  })

  it('the vehicle relabel RPC is service-role only', () => {
    const fn = /function\s+public\.lp_retag_portfolio_group\s*\(/i
    const roles = revokedRoles(/execute|all/i, fn)
    for (const r of ['public', 'anon', 'authenticated']) expect(roles.has(r), `not revoked from ${r}`).toBe(true)
    expect(sql).toMatch(/grant\s+execute\s+on\s+function\s+public\.lp_retag_portfolio_group\s*\([^)]*\)\s+to\s+service_role\s*;/i)
  })

  it('the portfolio_group lock waits in pending-deploy, with its release named, until the app uses the RPC', () => {
    const pending = join(ROOT, 'supabase', 'pending-deploy', 'lock_shared_lp_reports_vehicle.sql')
    // Once it has been moved into migrations/ (after the release ships) this check is moot.
    if (!existsSync(pending)) {
      expect(sql).toMatch(/app\.lp_vehicle_retag/)
      return
    }
    const p = readFileSync(pending, 'utf8')
    expect(p).toMatch(/^-- PENDING DEPLOY/)
    expect(p).toMatch(/lp_retag_portfolio_group/)
    expect(norm(p)).toContain("current_setting('app.lp_vehicle_retag', true)")
  })
})

describe('the audit tables are append-only', () => {
  for (const table of ['accounting_audit_events', 'tax_year_close_events']) {
    describe(table, () => {
      const on = new RegExp(`^\\s*(?:table\\s+)?public\\.${table}\\s*$`, 'i')

      it('revokes update, delete and truncate from service_role, anon and authenticated', () => {
        for (const priv of ['update', 'delete', 'truncate']) {
          const roles = revokedRoles(new RegExp(`\\b(${priv}|all)\\b`, 'i'), on)
          for (const r of ['service_role', 'anon', 'authenticated']) expect(roles.has(r), `${priv} not revoked from ${r}`).toBe(true)
        }
      })

      it('never grants update, delete or truncate back', () => {
        for (const m of sql.matchAll(new RegExp(`\\bgrant\\s+([^;]*?)\\s+on\\s+(?:table\\s+)?public\\.${table}\\s+to\\s+[^;]+;`, 'gi'))) {
          expect(m[1].toLowerCase()).not.toMatch(/\b(update|delete|truncate|all)\b/)
        }
      })

      it('has a row trigger refusing update and delete (cascades excepted)', () => {
        expect(latestTrigger(`${table}_no_change`)).toMatch(new RegExp(`before update or delete on public\\.${table} for each row`))
        const fn = norm(latestFunction(`${table}_immutable`))
        expect(fn).toMatch(/tg_op = 'delete' and pg_trigger_depth\(\) > 1/)
        expect(fn).toMatch(/raise exception/)
      })

      it('has a statement trigger refusing truncate', () => {
        expect(latestTrigger(`${table}_no_truncate`)).toMatch(new RegExp(`before truncate on public\\.${table} for each statement`))
        expect(norm(latestFunction('refuse_truncate_append_only'))).toMatch(/raise exception/)
      })
    })
  }
})
