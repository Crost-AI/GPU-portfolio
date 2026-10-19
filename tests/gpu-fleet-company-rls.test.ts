import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TABLE_RULES } from '@/lib/access/table-domains'

// ── GPU fleet (P3) ── #91: a fleet company's rows need `fleet` in RLS as well as in the routes.
// No local Postgres runs in CI, so this pins the SQL: the restrictive policies exist, the helpers
// return only what the policies hide, and EVERY browser-reachable table keyed by company_id is in
// the migration's list — a new such table fails here until it is added.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')
const FILE = '20261019310000_gpu_fleet_metrics.sql'
const sql = readFileSync(join(MIGRATIONS, FILE), 'utf8')
const all = readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort().map(f => readFileSync(join(MIGRATIONS, f), 'utf8')).join('\n')

/** Tables that have a company_id column, from every create table and add column in the history. */
function companyIdTables(): string[] {
  const out = new Set<string>()
  const create = /create table (?:if not exists )?(?:public\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\n\);/gi
  let m: RegExpExecArray | null
  while ((m = create.exec(all)) !== null) if (/^\s*company_id\s/m.test(m[2])) out.add(m[1])
  const alter = /alter table (?:only )?(?:if exists )?(?:public\.)?([a-z_0-9]+)\s+add column (?:if not exists )?company_id\b/gi
  while ((m = alter.exec(all)) !== null) out.add(m[1])
  return Array.from(out)
}

/** The table list in the migration's do-block. */
function listed(): string[] {
  const block = sql.slice(sql.indexOf('tables text[] := array['), sql.indexOf('];', sql.indexOf('tables text[] := array[')))
  return Array.from(block.matchAll(/'([a-z_0-9]+)'/g), x => x[1])
}

describe('fleet company RLS (#91)', () => {
  it('gates every browser-reachable table keyed by company_id', () => {
    // Browser-reachable = anything the registry does not keep service-only or leave alone.
    const reachable = companyIdTables().filter(t => {
      const rule = (TABLE_RULES as Record<string, { scope: string }>)[t]
      return rule && rule.scope !== 'service' && rule.scope !== 'keep'
    })
    expect(reachable.length).toBeGreaterThan(15)
    expect(reachable.filter(t => !listed().includes(t)), 'tables with company_id and a Data API grant missing from the fleet list').toEqual([])
    for (const t of ['metrics', 'metric_values', 'company_documents', 'company_summaries', 'company_updates', 'company_notes', 'inbound_emails', 'interactions']) {
      expect(listed()).toContain(t)
    }
  })

  it('adds RESTRICTIVE policies only, letting a row about no company through, and restates no permissive policy', () => {
    expect(sql).toContain("r text := 'company_id is null or not (company_id = any((select public.gpu_fleet_company_ids_unreadable())))'")
    expect(sql).toContain("w text := 'company_id is null or not (company_id = any((select public.gpu_fleet_company_ids_unwritable())))'")
    for (const cmd of ['select to authenticated using', 'insert to authenticated with check', 'update to authenticated using', 'delete to authenticated using']) {
      expect(sql).toContain(`as restrictive for ${cmd}`)
    }
    expect(sql).not.toMatch(/create policy "[a-z_]+ read needs portfolio"/)
    expect(sql).not.toMatch(/drop policy if exists "[a-z_]+ read needs portfolio"/)
  })

  it('gates the fleet company row itself by its holding_type', () => {
    expect(sql).toMatch(/create policy "gpu_fleet companies read needs fleet"\s+on public\.companies as restrictive for select to authenticated\s+using \(holding_type is distinct from 'gpu_fleet' or fund_id = any\(\(select public\.fund_ids_readable\('fleet'\)\)\)\);/)
    for (const verb of ['insert', 'update', 'delete']) {
      expect(sql).toMatch(new RegExp(`create policy "gpu_fleet companies ${verb} needs fleet write"\\s+on public\\.companies as restrictive for ${verb}`))
    }
  })

  it('the helpers return only the fleet companies the caller may NOT reach, and are not callable anonymously', () => {
    for (const [fn, level] of [['gpu_fleet_company_ids_unreadable', 'readable'], ['gpu_fleet_company_ids_unwritable', 'writable']]) {
      const body = sql.slice(sql.indexOf(`create or replace function public.${fn}()`), sql.indexOf('$$;', sql.indexOf(`create or replace function public.${fn}()`)))
      expect(body).toContain('security definer')
      expect(body).toContain('set search_path = public')
      expect(body).toContain("c.holding_type = 'gpu_fleet'")
      expect(body).toContain('c.fund_id = any(public.member_fund_ids())')
      expect(body).toContain(`not (c.fund_id = any(public.fund_ids_${level}('fleet')))`)
      expect(sql).toContain(`revoke execute on function public.${fn}() from public, anon;`)
    }
  })

  it('the latest-value views read as the caller, so they inherit the metric_values policy', () => {
    const views = readFileSync(join(MIGRATIONS, '20261014180000_metric_values_latest_views.sql'), 'utf8')
    expect(views.match(/with \(security_invoker = true\)/g)?.length).toBe(2)
  })
})
