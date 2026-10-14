import { describe, it, expect } from 'vitest'
import { seedCompanyFromDefaults, applyDefaultsToAllCompanies } from './seed-default-metrics'

/**
 * A minimal stand-in for the supabase query builder covering only the calls the seeder makes:
 *   .from('default_metrics').select(..).eq(..).eq(..).order(..)                  → templates
 *   .from('metrics').select(..).in('company_id', ids).order('id').range(f, t)    → existing slugs (paged)
 *   .from('metrics').insert(rows)                                                → capture rows
 *   .from('metrics').upsert(rows, { ignoreDuplicates }).select('id')             → capture new rows, skip dup (company_id, slug)
 *   .from('default_metric_exclusions').select(..).in('company_id', ids)...       → excluded default ids
 *   .from('companies').select('id').eq('fund_id', ..)                            → company ids
 * Every read is recorded in `reads` so tests can assert how many round trips were made.
 */
function makeClient(opts: {
  templates: any[]
  existingByCompany: Record<string, string[]>
  excludedByCompany?: Record<string, string[]>
  companies?: string[]
  /** Fail the read of this table with this message (data: null). */
  failRead?: { table: string; message: string }
  /** Return an error message to fail that insert call. */
  failInsert?: (rows: any[], call: number) => string | null
}) {
  const inserted: any[] = []
  const reads: { table: string; ids?: string[]; range?: [number, number] }[] = []
  let insertCalls = 0

  // Rows carry a stable id so `.order('id').range()` pages exactly like PostgREST.
  const rowsFor = (byCompany: Record<string, string[]>, ids: string[], key: string) =>
    ids.flatMap(c => (byCompany[c] ?? []).map((v, i) => ({ id: `${c}-${String(i).padStart(6, '0')}`, company_id: c, [key]: v })))
      .sort((x, y) => x.id.localeCompare(y.id))

  function builder(table: string) {
    const state: any = { table, filters: {} as Record<string, unknown> }
    const chain: any = {
      select(_cols?: string) { return chain },
      eq(col: string, val: unknown) { state.filters[col] = val; return chain },
      in(col: string, vals: unknown[]) { state.filters[col] = vals; return chain },
      order() { return chain },
      range(from: number, to: number) { state.range = [from, to]; return chain },
      insert(rows: any[]) {
        const err = opts.failInsert?.(rows, insertCalls++) ?? null
        if (err) return Promise.resolve({ data: null, error: { message: err } })
        inserted.push(...rows)
        return Promise.resolve({ data: rows, error: null })
      },
      upsert(rows: any[], o: { onConflict?: string; ignoreDuplicates?: boolean }) {
        const err = opts.failInsert?.(rows, insertCalls++) ?? null
        const taken = (r: any) => (opts.existingByCompany[r.company_id] ?? []).includes(r.slug)
          || inserted.some(x => x.company_id === r.company_id && x.slug === r.slug)
        const ignore = o.onConflict === 'company_id,slug' && o.ignoreDuplicates
        const fresh = ignore ? rows.filter(r => !taken(r)) : rows
        const dup = !ignore && rows.some(taken) ? 'duplicate key value violates unique constraint' : null
        const fail = err ?? dup
        return { select: () => Promise.resolve(fail ? { data: null, error: { message: fail } } : (inserted.push(...fresh), { data: fresh, error: null })) }
      },
      then(resolve: (v: any) => void) {
        const page = (rows: any[]) => state.range ? rows.slice(state.range[0], state.range[1] + 1) : rows
        const ids = state.filters['company_id'] as string[] | undefined
        reads.push({ table, ids, range: state.range })
        if (opts.failRead?.table === table) return resolve({ data: null, error: { message: opts.failRead.message } })
        if (table === 'default_metrics') return resolve({ data: opts.templates, error: null })
        if (table === 'companies') return resolve({ data: (opts.companies ?? []).map(id => ({ id })), error: null })
        if (table === 'metrics') {
          return resolve({ data: page(rowsFor(opts.existingByCompany, ids ?? [], 'slug')), error: null })
        }
        if (table === 'default_metric_exclusions') {
          return resolve({ data: page(rowsFor(opts.excludedByCompany ?? {}, ids ?? [], 'default_metric_id')), error: null })
        }
        return resolve({ data: [], error: null })
      },
    }
    return chain
  }

  const client: any = { from: (table: string) => builder(table) }
  return { client, inserted, reads }
}

const T = (slug: string, name = slug) => ({
  id: `dm-${slug}`, name, slug, description: null, unit: null, unit_position: 'suffix',
  value_type: 'number', reporting_cadence: 'quarterly', display_order: 0, currency: null,
})

describe('seedCompanyFromDefaults', () => {
  it('inserts only templates the company does not already have (dedup by slug)', async () => {
    const { client, inserted } = makeClient({
      templates: [T('cash'), T('arr'), T('headcount')],
      existingByCompany: { 'co-1': ['cash'] }, // company already tracks cash
    })

    const count = await seedCompanyFromDefaults(client, 'fund-1', 'co-1')

    expect(count).toBe(2)
    expect(inserted.map(r => r.slug).sort()).toEqual(['arr', 'headcount'])
    // never re-inserts the existing slug
    expect(inserted.some(r => r.slug === 'cash')).toBe(false)
    // stamps tenancy from the arguments, not the request
    expect(inserted.every(r => r.fund_id === 'fund-1' && r.company_id === 'co-1')).toBe(true)
  })

  it('is a no-op when the company already has every default', async () => {
    const { client, inserted } = makeClient({
      templates: [T('cash'), T('arr')],
      existingByCompany: { 'co-1': ['cash', 'arr'] },
    })
    const count = await seedCompanyFromDefaults(client, 'fund-1', 'co-1')
    expect(count).toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('skips defaults the company has opted out of (exclusions)', async () => {
    const { client, inserted } = makeClient({
      templates: [T('cash'), T('arr'), T('headcount')],
      existingByCompany: { 'co-1': [] },
      excludedByCompany: { 'co-1': ['dm-arr'] }, // opted out of ARR
    })

    const count = await seedCompanyFromDefaults(client, 'fund-1', 'co-1')

    expect(count).toBe(2)
    expect(inserted.map(r => r.slug).sort()).toEqual(['cash', 'headcount'])
    expect(inserted.some(r => r.slug === 'arr')).toBe(false)
  })

  it('is a no-op when the fund has no default metrics', async () => {
    const { client, inserted } = makeClient({ templates: [], existingByCompany: {} })
    const count = await seedCompanyFromDefaults(client, 'fund-1', 'co-1')
    expect(count).toBe(0)
    expect(inserted).toHaveLength(0)
  })
})

describe('applyDefaultsToAllCompanies', () => {
  it('seeds each company independently, deduping per company', async () => {
    const { client, inserted } = makeClient({
      templates: [T('cash'), T('arr')],
      existingByCompany: { 'co-1': ['cash'], 'co-2': [] }, // co-2 has none
      companies: ['co-1', 'co-2'],
    })

    const res = await applyDefaultsToAllCompanies(client, 'fund-1', null)

    expect(res.companies).toBe(2)
    expect(res.inserted).toBe(3) // co-1: arr; co-2: cash + arr
    expect(inserted.filter(r => r.company_id === 'co-1').map(r => r.slug)).toEqual(['arr'])
    expect(inserted.filter(r => r.company_id === 'co-2').map(r => r.slug).sort()).toEqual(['arr', 'cash'])
  })
})

describe('applyDefaultsToAllCompanies — batching', () => {
  const companies = (n: number) => Array.from({ length: n }, (_, i) => `co-${String(i).padStart(3, '0')}`)

  it('reads templates once and existing rows in batched .in() reads, not once per company', async () => {
    const ids = companies(250)
    const { client, inserted, reads } = makeClient({
      templates: [T('cash'), T('arr')],
      existingByCompany: {},
      companies: ids,
    })

    const res = await applyDefaultsToAllCompanies(client, 'fund-1', null)

    expect(res).toEqual({ inserted: 500, companies: 250, errors: [] })
    expect(inserted).toHaveLength(500)
    expect(reads.filter(r => r.table === 'default_metrics')).toHaveLength(1)
    const metricReads = reads.filter(r => r.table === 'metrics')
    const exclusionReads = reads.filter(r => r.table === 'default_metric_exclusions')
    // 250 companies in chunks of 100 → 3 reads each, every one a multi-company .in()
    expect(metricReads).toHaveLength(3)
    expect(exclusionReads).toHaveLength(3)
    expect(metricReads.map(r => r.ids!.length)).toEqual([100, 100, 50])
    expect(new Set(metricReads.flatMap(r => r.ids!))).toEqual(new Set(ids))
  })

  it('reports a failed insert chunk in errors without zeroing the other chunks', async () => {
    const ids = companies(300)
    const { client, inserted } = makeClient({
      templates: [T('cash'), T('arr')],
      existingByCompany: {},
      companies: ids,
      failInsert: (_rows, call) => (call === 0 ? 'duplicate key value violates unique constraint' : null),
    })

    const res = await applyDefaultsToAllCompanies(client, 'fund-1', null)

    // 600 rows → chunks of 500 + 100; the first fails, the second lands
    expect(res.inserted).toBe(100)
    expect(inserted).toHaveLength(100)
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]).toMatch(/500 metrics for 250 companies/)
    expect(res.errors[0]).toMatch(/co-000/)
    // the DB's own text is logged, not returned to the client
    expect(res.errors[0]).not.toMatch(/duplicate key/)
  })

  it('still skips existing slugs and exclusions per company when batched', async () => {
    const { client, inserted } = makeClient({
      templates: [T('cash'), T('arr'), T('headcount')],
      existingByCompany: { 'co-1': ['cash'] },
      excludedByCompany: { 'co-2': ['dm-arr'] },
      companies: ['co-1', 'co-2', 'co-3'],
    })

    const res = await applyDefaultsToAllCompanies(client, 'fund-1', null)

    expect(res.inserted).toBe(7)
    expect(inserted.filter(r => r.company_id === 'co-1').map(r => r.slug).sort()).toEqual(['arr', 'headcount'])
    expect(inserted.filter(r => r.company_id === 'co-2').map(r => r.slug).sort()).toEqual(['cash', 'headcount'])
    expect(inserted.filter(r => r.company_id === 'co-3')).toHaveLength(3)
  })

  it('pages existing metrics past 1000 rows, so a slug at row 1200 is not re-seeded', async () => {
    const many = Array.from({ length: 1500 }, (_, i) => `m${i}`)
    many[1200] = 'cash'
    const { client, inserted, reads } = makeClient({
      templates: [T('cash'), T('arr')],
      existingByCompany: { 'co-1': many },
      companies: ['co-1'],
    })

    const res = await applyDefaultsToAllCompanies(client, 'fund-1', null)

    expect(reads.filter(r => r.table === 'metrics')).toHaveLength(2) // rows 0-999, then 1000-1999
    expect(res.inserted).toBe(1)
    expect(inserted.map(r => r.slug)).toEqual(['arr'])
  })
})

describe('a failed template read', () => {
  it('is reported by the fund-wide apply, without the database text', async () => {
    const { client, inserted, reads } = makeClient({
      templates: [T('cash')], existingByCompany: {}, companies: ['co-1', 'co-2'],
      failRead: { table: 'default_metrics', message: 'canceling statement due to statement timeout' },
    })

    const res = await applyDefaultsToAllCompanies(client, 'fund-1', null)

    expect(res.inserted).toBe(0)
    expect(res.companies).toBe(2)
    expect(res.errors).toEqual(['Reading the default metrics failed; no defaults were applied'])
    expect(inserted).toHaveLength(0)
    expect(reads.some(r => r.table === 'metrics')).toBe(false)
  })

  it('leaves the single-company seed logging and returning 0', async () => {
    const { client, inserted } = makeClient({
      templates: [T('cash')], existingByCompany: {},
      failRead: { table: 'default_metrics', message: 'canceling statement due to statement timeout' },
    })
    expect(await seedCompanyFromDefaults(client, 'fund-1', 'co-1')).toBe(0)
    expect(inserted).toHaveLength(0)
  })

  it('a failed company read is reported too', async () => {
    const { client, inserted } = makeClient({
      templates: [T('cash')], existingByCompany: {}, companies: ['co-1'],
      failRead: { table: 'companies', message: 'connection reset' },
    })

    const res = await applyDefaultsToAllCompanies(client, 'fund-1', null)

    expect(res).toEqual({ inserted: 0, companies: 0, errors: ['Reading the companies failed; no defaults were applied'] })
    expect(inserted).toHaveLength(0)
  })
})

describe('a concurrent apply', () => {
  it('skips a slug another request seeded first instead of failing the whole chunk', async () => {
    const existing: Record<string, string[]> = { 'co-1': [] }
    const { client, inserted } = makeClient({
      templates: [T('cash'), T('arr')], existingByCompany: existing, companies: ['co-1', 'co-2'],
    })
    // Between our read and our write, a double-click seeds co-1's cash.
    const from = client.from
    client.from = (t: string) => {
      const q = from(t)
      const upsert = q.upsert
      q.upsert = (rows: any[], o: any) => { existing['co-1'] = ['cash']; return upsert(rows, o) }
      return q
    }

    const res = await applyDefaultsToAllCompanies(client, 'fund-1', null)

    expect(res.errors).toEqual([])
    expect(res.inserted).toBe(3) // only the rows actually written
    expect(inserted.filter(r => r.company_id === 'co-1').map(r => r.slug)).toEqual(['arr'])
  })
})
