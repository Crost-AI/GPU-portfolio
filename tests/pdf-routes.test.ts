import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { CHROMIUM_FILES, PDF_ROUTES, pdfTracingIncludes } from '@/lib/pdf-routes.mjs'

/**
 * Every route that can reach headless Chromium ships Chromium's binary (lib/pdf-routes.mjs).
 *
 * The build tracer follows imports, not the path @sparticuz/chromium computes for its archives, so
 * a PDF route left off the list builds, deploys and passes every test — then fails at render on
 * Vercel, behind whatever error the route turns a failure into. The report links turned it into
 * "This link has expired". So the list is checked against the import graph rather than trusted.
 */

const ROOT = process.cwd()

/** The matcher Next itself applies to outputFileTracingIncludes keys (build/collect-build-traces.js). */
const picomatch = createRequire(import.meta.url)('next/dist/compiled/picomatch') as
  (glob: string, opts: { dot?: boolean; contains?: boolean }) => (input: string) => boolean
const API_DIR = path.join(ROOT, 'app', 'api')

function findRouteFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...findRouteFiles(full))
    else if (entry === 'route.ts') out.push(full)
  }
  return out
}

/** '@/x' and relative specifiers, static or dynamic — the only ones that can reach our own files. */
const SPECIFIER = /(?:from\s+|import\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm

function resolveLocal(spec: string, fromFile: string): string | null {
  const base = spec.startsWith('@/') ? path.join(ROOT, spec.slice(2))
    : spec.startsWith('.') ? path.resolve(path.dirname(fromFile), spec)
    : null
  if (!base) return null
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, path.join(base, 'index.ts')]) {
    if (/\.(ts|tsx|mjs|js)$/.test(candidate) && existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

const reachesChromium = (() => {
  const memo = new Map<string, boolean>()
  const visit = (file: string, stack: Set<string>): boolean => {
    if (memo.has(file)) return memo.get(file)!
    if (stack.has(file)) return false
    stack.add(file)
    const source = readFileSync(file, 'utf8')
    let hit = false
    for (const [, spec] of source.matchAll(SPECIFIER)) {
      if (hit) break
      // An IMPORT of the package, not a mention: package.json names it and is imported for the
      // version, which would put every route that shows the version on the list.
      if (spec === '@sparticuz/chromium') { hit = true; break }
      const next = resolveLocal(spec, file)
      if (next && visit(next, stack)) hit = true
    }
    stack.delete(file)
    memo.set(file, hit)
    return hit
  }
  return (file: string) => visit(file, new Set())
})()

const routePath = (file: string) =>
  '/' + path.relative(path.join(ROOT, 'app'), path.dirname(file)).split(path.sep).join('/')

describe('PDF routes ship Chromium', () => {
  const reaching = findRouteFiles(API_DIR).filter(reachesChromium).map(routePath).sort()

  it('finds the PDF routes at all (the graph walk works)', () => {
    expect(reaching).toContain('/api/agent/reports/[token]')
    expect(reaching).toContain('/api/accounting/lp-statement/pdf')
  })

  it('lists every route whose imports reach @sparticuz/chromium', () => {
    const missing = reaching.filter(r => !PDF_ROUTES.includes(r))
    expect(missing, `add these to PDF_ROUTES in lib/pdf-routes.mjs, or their PDFs fail on Vercel`).toEqual([])
  })

  it('lists no route that does not render', () => {
    const stale = PDF_ROUTES.filter(r => !reaching.includes(r))
    expect(stale, 'these no longer reach Chromium — drop them, they carry ~67 MB for nothing').toEqual([])
  })

  it('keys match their routes the way Next matches them (picomatch, contains)', () => {
    const includes = pdfTracingIncludes()
    for (const route of PDF_ROUTES) {
      const keys = Object.keys(includes).filter(k => picomatch(k, { dot: true, contains: true })(route))
      expect(keys.length, `no tracing key matches ${route}`).toBeGreaterThan(0)
      for (const k of keys) expect(includes[k]).toEqual(CHROMIUM_FILES)
    }
  })

  it('points at files that exist', () => {
    expect(existsSync(path.join(ROOT, 'node_modules/@sparticuz/chromium/bin/chromium.br'))).toBe(true)
  })
})
