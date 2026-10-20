import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

// ── GPU fleet (P3) ── #91, made mechanical: every handler under app/api/companies/[id]/** reads with
// the service role, so RLS is out of the path and the only gate for a GPU SPV's fleet company is the
// one the handler calls. This fails for any handler — including a future sub-route — that does not
// call refuseFleetCompany before its first read or write, the way route-gates-honour-grants pins the
// domain gates.

const ROOT = path.join(process.cwd(), 'app', 'api', 'companies', '[id]')

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return routeFiles(full)
    return name === 'route.ts' ? [full] : []
  })
}

/** Each exported handler's source, up to the next export. */
function handlers(src: string): { method: string; body: string }[] {
  const re = /export async function (GET|POST|PUT|PATCH|DELETE)\b/g
  const starts: { method: string; at: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) starts.push({ method: m[1], at: m.index })
  return starts.map((s, i) => ({ method: s.method, body: src.slice(s.at, starts[i + 1]?.at ?? src.length) }))
}

describe('every company sub-route refuses a fleet company to a caller without fleet', () => {
  const files = routeFiles(ROOT)

  it('finds the routes (guards against a silently passing test)', () => {
    expect(files.length).toBeGreaterThanOrEqual(16)
  })

  it('calls refuseFleetCompany in every handler, before its first database access, at the method’s level', () => {
    const offenders: string[] = []
    for (const file of files) {
      for (const h of handlers(readFileSync(file, 'utf8'))) {
        const where = `${path.relative(process.cwd(), file)} ${h.method}`
        const gate = h.body.search(/refuseFleetCompany\(/)
        const firstRead = h.body.search(/\.from\(|\.rpc\(/)
        if (gate < 0) { offenders.push(`${where}: no refuseFleetCompany`); continue }
        if (firstRead >= 0 && firstRead < gate) offenders.push(`${where}: reads before refuseFleetCompany`)
        const level = h.body.slice(gate).match(/refuseFleetCompany\(.*?,\s*'(read|write)'\)/)?.[1]
        if (level !== (h.method === 'GET' ? 'read' : 'write')) offenders.push(`${where}: refuses at ${level ?? '?'}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

// The agent and the shared writers resolve a company through resolveCompany; a write to it must
// resolve at 'write' (fleet write for a fleet company). This fails for a new call site that is
// neither a known read nor passes 'write'.
describe('every resolveCompany call that writes resolves at write level', () => {
  /** Handlers that only read the company: they may resolve at read level. */
  const READ_ONLY = new Set(['get_updates', 'company_detail', 'list_investments', 'company_metrics', 'canonical'])
  const LIB = path.join(process.cwd(), 'lib')

  function tsFiles(dir: string): string[] {
    return readdirSync(dir).flatMap(name => {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) return tsFiles(full)
      return name.endsWith('.ts') && !name.endsWith('.test.ts') ? [full] : []
    })
  }

  it('finds the call sites, and each is a read handler or passes write', () => {
    const sites: string[] = []
    const offenders: string[] = []
    for (const file of tsFiles(LIB)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!/\bresolveCompany\(/.test(line) || /export async function resolveCompany/.test(line)) return
        if (/deps\.resolveCompany\(/.test(line)) return // bound by its caller (submit_company_update), at 'write'
        let name = '?'
        for (let j = i; j >= 0; j--) {
          const m = lines[j].match(/^\s*(\w+): async\b/) ?? lines[j].match(/(?:async )?function (\w+)\s*\(/)
          if (m) { name = m[1]; break }
        }
        const where = `${path.relative(process.cwd(), file)}:${i + 1} (${name})`
        sites.push(where)
        if (!/'write'\)/.test(line) && !READ_ONLY.has(name)) offenders.push(where)
      })
    }
    expect(sites.length).toBeGreaterThanOrEqual(15)
    expect(offenders).toEqual([])
  })
})

// Routes outside app/api/companies/[id]/** that return a company's data per row (#91, Codex on #98):
// each handler that reads one must apply the fleet gate.
describe('per-row fleet gates outside the company routes', () => {
  const GATED: [string, string, RegExp][] = [
    ['app/api/analyst/conversations/route.ts', 'GET', /firstVisibleRows<any>\(\(f, t\) => build\(\)\.order\('id'\)\.range\(f, t\), 20, fleetHidden\)/],
    ['app/api/analyst/conversations/route.ts', 'POST', /fleetCompanyDenied\(scope\.access, companyCheck\.holding_type\)/],
    ['app/api/analyst/conversations/[id]/route.ts', 'GET', /refuseFleetCompany\(admin, user\.id, \{ companyId \}, 'read'\)/],
    // Claude review on #98, B2 and S1.
    ['app/api/company-updates/search/route.ts', 'GET', /withoutHiddenFleet\(admin, fund\.fundId, scope\.access, scope\.companyIds\)/],
    ['app/api/company-updates/[id]/route.ts', 'GET', /hiddenFleetIdsInFund\(admin, fund\.fundId, user\.id\)[\s\S]*fleetHidden\.has\(/],
    ['app/api/company-updates/[id]/artifacts/[artifactId]/route.ts', 'GET', /hiddenFleetIdsInFund\(admin, fund\.fundId, user\.id\)[\s\S]*fleetHidden\.has\(/],
    ['app/api/notes/route.ts', 'GET', /hiddenFleetIdsInFund\(admin, membership\.fund_id, user\.id\)[\s\S]*firstVisibleRows/],
    ['app/api/interactions/route.ts', 'GET', /hiddenFleetIdsInFund\(admin, membership\.fund_id, user\.id\)[\s\S]*firstVisibleRows/],
    ['app/api/emails/[id]/route.ts', 'PATCH', /fleetCompanyDenied\(scope\.access, company\.holding_type, 'write'\)/],
  ]
  it.each(GATED)('%s %s applies the fleet gate', (file, method, gate) => {
    const h = handlers(readFileSync(path.join(process.cwd(), file), 'utf8')).find(x => x.method === method)
    expect(h, `${file} has no ${method}`).toBeDefined()
    expect(h!.body).toMatch(gate)
  })
})

describe('per-row fleet gates in the agent and the v1 API', () => {
  const src = (f: string) => readFileSync(path.join(process.cwd(), f), 'utf8')
  it('get_updates hands getUpdates a visible set without the hidden fleet companies', () => {
    const tools = src('lib/agent/portfolio-tools.ts')
    const body = tools.slice(tools.indexOf('get_updates: async'), tools.indexOf('list_vehicles: async'))
    expect(body).toMatch(/visibleCompanyIds: await withoutHiddenFleet\(admin, fundId, access as AccessContext, await visibleCompanyIds\(admin, access\)\)/)
  })
  it('the v1 API lists and fetches conversations through the fleet gate', () => {
    const v1 = src('lib/api-v1/conversations.ts')
    const list = v1.slice(v1.indexOf('export async function listConversations'), v1.indexOf('export async function getConversation'))
    const get = v1.slice(v1.indexOf('export async function getConversation'), v1.indexOf('export async function deleteConversation'))
    expect(list).toMatch(/hiddenFleetIdsInFund\(admin, principal\.fundId, principal\.userId\)/)
    expect(get).toMatch(/refuseFleetCompany\(admin, principal\.userId, \{ companyId: row\.company_id \}, 'read'\)/)
  })
})
