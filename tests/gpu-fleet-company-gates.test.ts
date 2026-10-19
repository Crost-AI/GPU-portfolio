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
