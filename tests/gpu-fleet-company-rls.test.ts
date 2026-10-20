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
  // A body ends at the first line that is only `);` (indented or not), so a statement cannot run on
  // into the next one's columns.
  const create = /create table (?:if not exists )?(?:public\.)?([a-z_0-9]+)\s*\(([\s\S]*?)\n\s*\);/gi
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
    // Browser-reachable = anything the registry does not keep service-only. 'keep' tables are
    // included: company_vehicles is 'keep' yet granted to authenticated, and carries the company id.
    const reachable = companyIdTables().filter(t => {
      const rule = (TABLE_RULES as Record<string, { scope: string }>)[t]
      return rule && rule.scope !== 'service'
    })
    expect(reachable).toContain('company_vehicles')
    expect(companyIdTables()).not.toContain('fund_member_vehicles')
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
    expect(sql).toMatch(/create policy "gpu_fleet companies read needs fleet"\s+on public\.companies as restrictive for select to authenticated\s+using \(holding_type is distinct from 'gpu_fleet'\s+or \(fund_id = any\(\(select public\.fund_ids_readable\('fleet'\)\)\) and fund_id = any\(\(select public\.fund_ids_readable\('accounting'\)\)\)\)\);/)
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
      // fleet in SQL requires accounting read, as DOMAIN_META.fleet.requires does in the app (#112).
      expect(body).toMatch(new RegExp(`not \\(c\\.fund_id = any\\(public\\.fund_ids_${level}\\('fleet'\\)\\)\\s+and c\\.fund_id = any\\(public\\.fund_ids_readable\\('accounting'\\)\\)\\);`))
      expect(sql).toContain(`revoke execute on function public.${fn}() from public, anon;`)
    }
  })

  it('the latest-value views read as the caller, so they inherit the metric_values policy', () => {
    const views = readFileSync(join(MIGRATIONS, '20261014180000_metric_values_latest_views.sql'), 'utf8')
    expect(views.match(/with \(security_invoker = true\)/g)?.length).toBe(2)
  })
})

// Review on #98: the fleet company's stored files, not only its rows. A browser reaches Storage with
// its own JWT; the bucket policies ask only for portfolio, and the entity rule lets an unscoped
// member reach every file in the fund.
describe('fleet company files in Storage (#91)', () => {
  const storageSql = sql.slice(sql.indexOf('-- 5. The fleet company'))
  const policy = (verb: string) => {
    const name = verb === 'select' ? 'gpu_fleet company files read needs fleet' : `gpu_fleet company files ${verb} needs fleet write`
    const at = storageSql.indexOf(`create policy "${name}"`)
    expect(at, name).toBeGreaterThan(-1)
    return storageSql.slice(at, storageSql.indexOf(';', at))
  }

  it('adds a RESTRICTIVE storage.objects policy for every command', () => {
    for (const verb of ['select', 'insert', 'update', 'delete']) {
      expect(policy(verb)).toMatch(new RegExp(`on storage\\.objects as restrictive for ${verb} to authenticated`))
    }
    // No permissive storage policy is restated.
    expect(storageSql).not.toMatch(/create policy "company-documents read needs portfolio"/)
  })

  it('gates company-documents by the company folder and email-attachments by the email’s company, at read and write level', () => {
    expect(policy('select')).toContain("(storage.foldername(name))[2] = any((select public.gpu_fleet_company_ids_unreadable())::text[])")
    expect(policy('select')).toContain("public.gpu_fleet_email_hidden((storage.foldername(name))[1], false)")
    for (const verb of ['insert', 'update', 'delete']) {
      expect(policy(verb)).toContain("(storage.foldername(name))[2] = any((select public.gpu_fleet_company_ids_unwritable())::text[])")
      expect(policy(verb)).toContain("public.gpu_fleet_email_hidden((storage.foldername(name))[1], true)")
    }
  })

  it('covers every bucket the entity rule treats as company-scoped', () => {
    const entity = readFileSync(join(MIGRATIONS, '20261007100500_entity_storage.sql'), 'utf8')
    const companyScoped = new Set<string>()
    // A bucket whose objects the entity rule resolves to a company: company_id folders or email rows.
    for (const m of entity.matchAll(/bucket_id = '([a-z-]+)'\s*and[\s\S]{0,200}?(company_ids_readable|inbound_emails)/g)) companyScoped.add(m[1])
    expect([...companyScoped].sort()).toEqual(['company-documents', 'email-attachments'])
    for (const bucket of companyScoped) expect(policy('select')).toContain(`bucket_id = '${bucket}'`)
  })

  it('the email helper reads as definer, casts only a uuid folder, and is not callable anonymously', () => {
    const fn = storageSql.slice(storageSql.indexOf('create or replace function public.gpu_fleet_email_hidden'), storageSql.indexOf('$$;', storageSql.indexOf('create or replace function public.gpu_fleet_email_hidden')))
    expect(fn).toContain('security definer')
    expect(fn).toContain('set search_path = public')
    expect(fn).toMatch(/p_folder ~\* '\^\[0-9a-f\]\{8\}/)
    expect(fn).toContain('public.gpu_fleet_company_ids_unwritable()')
    expect(fn).toContain('public.gpu_fleet_company_ids_unreadable()')
    expect(storageSql).toContain('revoke execute on function public.gpu_fleet_email_hidden(text, boolean) from public, anon;')
  })
})

// Claude B1 on #98: `fleet` in SQL must mean what it means in the app.
describe('fleet predicates require accounting read, as DOMAIN_META.fleet.requires does (#112)', () => {
  it('the app says fleet requires accounting', async () => {
    const { DOMAIN_META } = await import('@/lib/access/domains')
    expect(DOMAIN_META.fleet.requires).toBe('accounting')
  })

  it('no fleet predicate in the migration stands without accounting read beside it', () => {
    const fleetCalls = [...sql.matchAll(/fund_ids_(readable|writable)\('fleet'\)\)+/g)]
    expect(fleetCalls.length).toBe(7)
    for (const m of fleetCalls) {
      const after = sql.slice(m.index! + m[0].length, m.index! + m[0].length + 120)
      expect(after, sql.slice(m.index! - 60, m.index! + 160)).toMatch(/^\s*and c?\.?fund_id = any\(\(?(select )?public\.fund_ids_readable\('accounting'\)/)
    }
  })

  it('the company policies require accounting on every command', () => {
    for (const name of ['read needs fleet', 'insert needs fleet write', 'update needs fleet write', 'delete needs fleet write']) {
      const at = sql.indexOf(`create policy "gpu_fleet companies ${name}"`)
      const body = sql.slice(at, sql.indexOf(';', at))
      expect(body, name).toContain("fund_ids_readable('accounting')")
    }
  })
})
