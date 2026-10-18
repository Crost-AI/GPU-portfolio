import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'

// ── GPU fleet (P1) ── The same guardrail as tax-data-api-grants.test.ts, for the fleet register.
//
// Every table below is read only by an /api/fleet route gated on the `fleet` domain and the
// `gpu_fleet` feature, with createAdminClient(). A Data API grant knows nothing about either, so
// `grant select ... to authenticated` would hand the register (costs, serials, contracts) to a
// member the middleware refuses — including every member of a VC fund where `gpu_fleet` is off.

const MIGRATIONS = join(process.cwd(), 'supabase', 'migrations')

/** Tables whose only access path is a gated route holding the service-role key. */
const SERVICE_ROLE_ONLY = [
  'gpu_asset_types',
  'gpu_assets',
  'gpu_asset_events',
  'datacenter_contracts',
  'gpu_fleet_settings',
]

function migrationFiles(): { name: string; sql: string }[] {
  return readdirSync(MIGRATIONS)
    .filter(f => f.endsWith('.sql'))
    .map(name => ({ name, sql: readFileSync(join(MIGRATIONS, name), 'utf8') }))
}

interface GrantSite {
  file: string
  table: string
  roles: string[]
}

function scan(re: RegExp): GrantSite[] {
  const out: GrantSite[] = []
  for (const { name, sql } of migrationFiles()) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(sql)) !== null) {
      out.push({
        file: name,
        table: m[1].toLowerCase(),
        roles: m[2].split(',').map((r: string) => r.trim().toLowerCase()),
      })
    }
  }
  return out
}

/** Every `grant ... on public.<table> to <roles>;` across the migration history. */
function grantSites(): GrantSite[] {
  return scan(/\bgrant\s+[^;]*?\bon\s+(?:table\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+to\s+([^;]+);/gi)
}

/** Every `create policy ... on public.<table> ... to <roles>` across the migration history. */
function policySites(): GrantSite[] {
  return scan(
    /\bcreate\s+policy\s+[^;]*?\bon\s+(?:public\.)?([a-z_][a-z0-9_]*)\b[^;]*?\bto\s+([a-z_, ]+?)\b\s*(?:using|with|;)/gi,
  )
}

describe('GPU fleet tables are not on the Data API', () => {
  it.each(SERVICE_ROLE_ONLY)('%s is granted to service_role and nobody else', table => {
    const sites = grantSites().filter(g => g.table === table)
    expect(sites.length, `${table} has no grant statement in any migration`).toBeGreaterThan(0)
    for (const site of sites) {
      expect(site.roles, `${site.file} grants ${table} to ${site.roles.join(', ')}`).toEqual(['service_role'])
    }
  })

  it.each(SERVICE_ROLE_ONLY)('%s has no policy for a browser-reachable role, and RLS is on', table => {
    for (const site of policySites().filter(p => p.table === table)) {
      for (const role of site.roles) {
        expect(['anon', 'authenticated'].includes(role), `${site.file} has a policy on ${table} for ${role}`).toBe(false)
      }
    }
    const all = migrationFiles().map(f => f.sql).join('\n')
    expect(all).toContain(`alter table public.${table} enable row level security;`)
    expect(all).toContain(`revoke all on public.${table} from anon, authenticated;`)
  })

  it('has no insurance_claim column on gpu_asset_events (decision Q9)', () => {
    const sql = readFileSync(join(MIGRATIONS, '20261019110000_gpu_assets.sql'), 'utf8')
    expect(sql).not.toMatch(/insurance_claim/)
  })
})
