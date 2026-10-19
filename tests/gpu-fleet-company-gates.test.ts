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
