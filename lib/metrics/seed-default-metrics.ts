import type { SupabaseClient } from '@supabase/supabase-js'
import { filterByCompany } from '@/lib/access/scope'
import { fetchAllRows } from '@/lib/accounting/load'

/**
 * The fund-wide "default metric profile". An admin defines these once (Settings → Portfolio →
 * Default metrics); they are TEMPLATES that get copied into every company's own `metrics` rows.
 *
 * Copying is always insert-if-not-exists by (company_id, slug) — the same key the `metrics` table
 * enforces with unique(company_id, slug) — so a company already tracking a slug (whether hand-added
 * or seeded earlier) is never given a duplicate. Templates are seed-only: editing or deleting a
 * default metric here does NOT touch metrics already copied into companies.
 */

const TEMPLATE_COLUMNS =
  'name, slug, description, unit, unit_position, value_type, reporting_cadence, display_order, currency'

export type DefaultMetricTemplate = {
  id: string
  name: string
  slug: string
  description: string | null
  unit: string | null
  unit_position: string | null
  value_type: string | null
  reporting_cadence: string | null
  display_order: number | null
  currency: string | null
}

/** Map a default-metric template onto a company's `metrics` insert. */
function toMetricInsert(t: DefaultMetricTemplate, fundId: string, companyId: string) {
  return {
    company_id: companyId,
    fund_id: fundId,
    name: t.name,
    slug: t.slug,
    description: t.description ?? null,
    unit: t.unit ?? null,
    unit_position: t.unit_position ?? 'suffix',
    value_type: t.value_type ?? 'number',
    reporting_cadence: t.reporting_cadence ?? 'quarterly',
    display_order: t.display_order ?? 0,
    currency: t.currency ?? null,
    is_active: true,
  }
}

/**
 * The metrics rows to insert for ONE company: every template whose slug the company does not
 * already track and which it has not opted out of. Pure — shared by the single-company seed and
 * the fund-wide apply so both decide "missing" identically.
 */
export function plannedInserts(
  templates: DefaultMetricTemplate[],
  have: Set<string>,
  excluded: Set<string>,
  fundId: string,
  companyId: string,
) {
  return templates
    .filter(t => !have.has(t.slug) && !excluded.has(t.id))
    .map(t => toMetricInsert(t, fundId, companyId))
}

/** `.in()` list size for the per-company reads, and rows per `metrics` insert. */
const READ_CHUNK = 100
const INSERT_CHUNK = 500

type SeedState = { have: Map<string, Set<string>>; excluded: Map<string, Set<string>> }

/**
 * Existing slugs and opted-out default ids for a set of companies, keyed by company id. Pages past
 * the 1000-row cap (a stable `order('id')` keeps the pages disjoint), so a company whose slug sits
 * past row 1000 is still seen as having it. Throws on a failed read.
 */
async function readSeedState(admin: SupabaseClient, companyIds: string[]): Promise<SeedState> {
  const [metrics, exclusions] = await Promise.all([
    fetchAllRows<{ company_id: string; slug: string }>((f, t) => (admin as any)
      .from('metrics').select('company_id, slug').in('company_id', companyIds).order('id').range(f, t)),
    fetchAllRows<{ company_id: string; default_metric_id: string }>((f, t) => (admin as any)
      .from('default_metric_exclusions').select('company_id, default_metric_id').in('company_id', companyIds).order('id').range(f, t)),
  ])
  const group = (rows: { company_id: string }[], value: (r: any) => string) => {
    const out = new Map<string, Set<string>>()
    for (const r of rows) {
      let set = out.get(r.company_id)
      if (!set) out.set(r.company_id, set = new Set())
      set.add(value(r))
    }
    return out
  }
  return { have: group(metrics, r => r.slug), excluded: group(exclusions, r => r.default_metric_id) }
}

async function readTemplates(admin: SupabaseClient, fundId: string): Promise<DefaultMetricTemplate[]> {
  const { data: templates } = await admin
    .from('default_metrics')
    .select(`id, ${TEMPLATE_COLUMNS}`)
    .eq('fund_id', fundId)
    .eq('is_active', true)
    .order('display_order')
  return (templates ?? []) as DefaultMetricTemplate[]
}

const EMPTY = new Set<string>()
const errMessage = (e: unknown) => (e as { message?: string })?.message ?? String(e)

/**
 * Seed every active default metric into ONE company, skipping any slug the company already has.
 * Returns the number of metrics inserted. Used at company creation and by the per-company route.
 *
 * `onlyIds` narrows the seed to a chosen subset. The Add-company modal lets you uncheck defaults
 * before the company exists and passes through the ones that stayed checked; pass undefined for
 * the normal "seed every active default" behaviour. An empty array seeds nothing.
 */
export async function seedCompanyFromDefaults(
  admin: SupabaseClient,
  fundId: string,
  companyId: string,
  onlyIds?: string[]
): Promise<number> {
  const all = await readTemplates(admin, fundId)
  const keep = onlyIds ? new Set(onlyIds) : null
  const list = keep ? all.filter(t => keep.has(t.id)) : all
  if (list.length === 0) return 0

  let state: SeedState
  try {
    state = await readSeedState(admin, [companyId])
  } catch (e) {
    console.error('[seedCompanyFromDefaults] read failed:', errMessage(e))
    return 0
  }
  const toInsert = plannedInserts(list, state.have.get(companyId) ?? EMPTY, state.excluded.get(companyId) ?? EMPTY, fundId, companyId)
  if (toInsert.length === 0) return 0

  const { error } = await admin.from('metrics').insert(toInsert)
  if (error) {
    console.error('[seedCompanyFromDefaults] insert failed:', error.message)
    return 0
  }
  return toInsert.length
}

/** "co-1, co-2, co-3 +4 more" — enough to find the companies without a 500-id error string. */
function describeCompanies(ids: string[]): string {
  const shown = ids.slice(0, 5).join(', ')
  return ids.length > 5 ? `${shown} +${ids.length - 5} more` : shown
}

/**
 * Fan every active default metric out across ALL companies in the fund. Idempotent — a company
 * that already has a slug keeps its own row untouched.
 *
 * Reads the templates once and the companies' existing slugs/exclusions in batched `.in()` reads,
 * then inserts the missing rows in chunks. A failed read or insert is recorded in `errors` (naming
 * the companies it covered) and skips only that batch; `inserted` counts the rows that landed.
 * `errors` reaches the client, so the database's own message is logged here, never put in it.
 */
export async function applyDefaultsToAllCompanies(
  admin: SupabaseClient,
  fundId: string,
  /** The caller's companies (null = all). Required: a scoped member syncs only theirs. */
  visibleCompanyIds: string[] | null,
): Promise<{ inserted: number; companies: number; errors: string[] }> {
  const { data: companies } = await filterByCompany((admin as any)
    .from('companies')
    .select('id')
    .eq('fund_id', fundId)
    .eq('holding_type', 'company'),   // fund holdings have their own surfaces
    visibleCompanyIds, { column: 'id' })

  const ids = ((companies ?? []) as { id: string }[]).map(c => c.id)
  const errors: string[] = []
  const templates = ids.length ? await readTemplates(admin, fundId) : []
  if (templates.length === 0) return { inserted: 0, companies: ids.length, errors }

  const rows: ReturnType<typeof plannedInserts> = []
  for (let i = 0; i < ids.length; i += READ_CHUNK) {
    const chunk = ids.slice(i, i + READ_CHUNK)
    let state: SeedState
    try {
      state = await readSeedState(admin, chunk)
    } catch (e) {
      const msg = `Reading existing metrics for ${chunk.length} companies (${describeCompanies(chunk)}) failed`
      console.error('[applyDefaultsToAllCompanies]', `${msg}:`, errMessage(e))
      errors.push(msg)
      continue
    }
    for (const companyId of chunk) {
      rows.push(...plannedInserts(templates, state.have.get(companyId) ?? EMPTY, state.excluded.get(companyId) ?? EMPTY, fundId, companyId))
    }
  }

  let inserted = 0
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK)
    const { error } = await admin.from('metrics').insert(chunk)
    if (error) {
      const companyIds = Array.from(new Set(chunk.map(r => r.company_id)))
      const msg = `Inserting ${chunk.length} metrics for ${companyIds.length} companies (${describeCompanies(companyIds)}) failed`
      console.error('[applyDefaultsToAllCompanies]', `${msg}:`, error.message)
      errors.push(msg)
      continue
    }
    inserted += chunk.length
  }
  return { inserted, companies: ids.length, errors }
}
