import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { memoryAdmin } from '@/tests/helpers/memory-admin'

/**
 * #82: a source_ref is the system's tag, and code trusts it (the GPU fleet adopts a `gpu-asset:`
 * entry as its own purchase or disposal; `reversal:<id>` says what an entry undoes). Every
 * user-authored write path refuses a reserved ref before anything is written: the journal POST and
 * PUT, the ledger-text REST route and the post_ledger_text tool. The round-trip export refs stay
 * writable (#88). The scan at the bottom keeps the reserved list complete.
 */

const s = vi.hoisted(() => ({ m: null as any }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) } }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => s.m.admin }))
vi.mock('@/lib/api-helpers', () => ({
  assertWriteAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin', need: 'write' }),
  assertReadAccess: async () => ({ fundId: 'f', userId: 'u', role: 'admin', need: 'read' }),
}))
vi.mock('@/lib/accounting/http-vehicle', () => ({ resolveGroupOr400: async (_a: any, _g: any, raw: string) => raw }))
vi.mock('@/lib/access/effective', async orig => ({ ...(await orig<any>()), loadAccessContext: async () => ({ grants: {}, defaults: {}, features: {}, role: 'admin', vehicles: { all: true, ids: [] } }) }))
vi.mock('@/lib/accounting/persist', async orig => ({ ...(await orig<any>()), persistEntry: vi.fn(async () => ({ entryId: 'je-1' })) }))

import { POST, PUT } from '@/app/api/accounting/journal/route'
import { POST as postText } from '@/app/api/accounting/ledger-text/route'
import { getTool } from '@/lib/accounting/agent-tools'
import { persistEntry } from '@/lib/accounting/persist'
import {
  RESERVED_SOURCE_REF_PREFIXES, ROUND_TRIP_EXEMPT_PREFIXES, EDIT_LOCKED_PREFIXES, assertUserRefAllowed, isReservedSourceRef,
} from '@/lib/accounting/reserved-refs'

beforeEach(() => {
  vi.clearAllMocks()
  s.m = memoryAdmin({
    fund_settings: [{ fund_id: 'f', currency: 'USD' }], vendors: [], journal_postings: [],
    fund_vehicles: [{ id: 'v', fund_id: 'f', name: 'H200 SPV I', kind: 'gpu_spv', aliases: [] }],
    journal_entries: [{ id: 'je-fleet', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'draft', entry_date: '2027-01-05', source_type: 'manual', source_ref: 'gpu-asset:a1:purchase' }],
  })
})

const FORBIDDEN = ['gpu-asset:a1:purchase', 'gpu-dep:a1:2027-01', 'fleet:insurance:P:2027-01-01', 'reversal:je-9', 'intercompany:c1', 'allocation:x', 'close:p1', 'partner-opening']
const postings = [{ accountId: 'a', amount: 1 }, { accountId: 'b', amount: -1 }]
const journal = (method: 'POST' | 'PUT', body: object) =>
  new NextRequest('https://x.test/api/accounting/journal', { method, body: JSON.stringify({ group: 'H200 SPV I', entryDate: '2027-01-05', postings, ...body }) })
const ledgerText = (ref: string) => ['2027-01-05 * "Forged purchase"', `  ref: "${ref}"`, '  source: "manual"', '  Assets:Equipment:1600  10.00 USD', '  Assets:Cash:1000  -10.00 USD', ''].join('\n')

describe('the reserved and exempt lists', () => {
  it('reserves the fleet, allocation, close, intercompany and correction namespaces; exempts only the round-trip export refs', () => {
    expect([...RESERVED_SOURCE_REF_PREFIXES]).toEqual(expect.arrayContaining(['gpu-asset:', 'gpu-dep:', 'fleet:', 'reversal:', 'close:', 'tax:', 'receipt:', 'schedule:', 'recurring:']))
    expect([...ROUND_TRIP_EXEMPT_PREFIXES]).toEqual(['txn:', 'qb:', 'adopted:', 'carta:'])
    expect(ROUND_TRIP_EXEMPT_PREFIXES.every(p => (RESERVED_SOURCE_REF_PREFIXES as readonly string[]).includes(p))).toBe(true)
    // GPU fleet (P3) adds its operations refs.
    expect([...EDIT_LOCKED_PREFIXES]).toEqual(['gpu-asset:', 'gpu-dep:', 'marketplace:', 'marketplace-payout:'])
    for (const ref of FORBIDDEN) expect(assertUserRefAllowed(ref), ref).toMatch(/reserved/)
    for (const ref of ['txn:t1', 'qb:abc', 'adopted:e1', 'carta:x']) {
      expect(assertUserRefAllowed(ref), ref).toMatch(/reserved/)
      expect(assertUserRefAllowed(ref, { allowRoundTrip: true }), ref).toBeNull()
    }
    for (const ref of ['INV-4471', null]) expect(assertUserRefAllowed(ref)).toBeNull()
    expect(isReservedSourceRef('  GPU-DEP:x')).toBe(true)
  })

  it('names every source_ref prefix a system writer in lib/ or app/ uses', () => {
    // Every string the code builds a ref from: sourceRef/source_ref literals, .eq/.like('source_ref', …),
    // and the *Ref / *RefPrefix / REF_PREFIX helpers (including `const xRef = { … }` maps).
    const files: string[] = []
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        if (f === 'node_modules' || f.startsWith('.')) continue
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.tsx?$/.test(f) && !/\.test\./.test(f)) files.push(p)
      }
    }
    walk(join(process.cwd(), 'lib'))
    walk(join(process.cwd(), 'app'))
    const patterns = [
      /sourceRef\s*[:=]\s*[`'"]([a-z][a-z0-9-]*:?)/g,
      /['"]source_ref['"]\s*,\s*[`'"]([a-z][a-z0-9-]*:)/g,
      /source_ref\s*:\s*[`'"]([a-z][a-z0-9-]*:?)/g,
      /\b\w*(?:Ref|RefPrefix|REF|REF_PREFIX|tag)\s*=\s*(?:\([^)]*\)\s*(?::\s*\w+\s*)?=>\s*)?[`'"]([a-z][a-z0-9-]*:)/g,
      /function \w*Ref\w*\([^)]*\)[^{]*\{\s*return\s*[`'"]([a-z][a-z0-9-]*:)/g,
    ]
    const refMap = /\b\w*Ref\s*=\s*\{([\s\S]*?)\n\}/g
    const NOT_LEDGER = new Set(['vehicle:'])
    const found = new Map<string, string>()
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const re of patterns) { re.lastIndex = 0; let m; while ((m = re.exec(src))) if (!found.has(m[1])) found.set(m[1], f) }
      refMap.lastIndex = 0
      let b
      while ((b = refMap.exec(src))) for (const m of b[1].matchAll(/[`'"]([a-z][a-z0-9-]*:)/g)) if (!found.has(m[1])) found.set(m[1], f)
    }
    expect(found.size).toBeGreaterThan(15)
    const missing = Array.from(found.entries()).filter(([p]) => !NOT_LEDGER.has(p) && !isReservedSourceRef(p)).map(([p, f]) => `${p} (${f})`)
    expect(missing, 'add these system prefixes to RESERVED_SOURCE_REF_PREFIXES').toEqual([])
    for (const fleet of ['gpu-asset:', 'gpu-dep:', 'fleet:']) expect(found.has(fleet), fleet).toBe(true)
  })
})

describe('every user-authored write path refuses a reserved ref before writing', () => {
  it.each(FORBIDDEN)('journal POST refuses %s', async ref => {
    const r = await POST(journal('POST', { sourceRef: ref }))
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/reserved/)
    expect(persistEntry).not.toHaveBeenCalled()
  })

  it('journal POST takes an ordinary ref, but not even a round-trip export ref (only ledger text re-imports those)', async () => {
    expect((await POST(journal('POST', { sourceRef: 'bank:2027-01-05:42' }))).status).not.toBe(400)
    expect((await POST(journal('POST', { sourceRef: 'txn:t1' }))).status).toBe(400)
    expect(persistEntry).toHaveBeenCalledOnce()
  })

  it('journal PUT refuses to rewrite a fleet draft, and refuses a reserved ref in the body', async () => {
    const locked = await PUT(journal('PUT', { id: 'je-fleet' }))
    expect(locked.status).toBe(400)
    expect((await locked.json()).error).toMatch(/GPU fleet entry/)
    s.m.tables.journal_entries.push({ id: 'je-mine', fund_id: 'f', vehicle_id: 'v', book: 'actual', status: 'draft', entry_date: '2027-01-05', source_type: 'manual', source_ref: null })
    const reserved = await PUT(journal('PUT', { id: 'je-mine', sourceRef: 'gpu-dep:a1:2027-01' }))
    expect(reserved.status).toBe(400)
    expect((await reserved.json()).error).toMatch(/reserved/)
    expect(s.m.tables.journal_postings).toEqual([])
  })

  it.each(['gpu-asset:a1:purchase', 'gpu-dep:a1:2027-01', 'reversal:je-9'])('ledger-text REST refuses %s', async ref => {
    const r = await postText(new NextRequest('https://x.test/api/accounting/ledger-text', { method: 'POST', body: JSON.stringify({ group: 'H200 SPV I', text: ledgerText(ref), status: 'posted' }) }))
    const body = await r.json()
    expect(body.posted ?? 0).toBe(0)
    expect(JSON.stringify(body)).toMatch(/reserved/)
    expect(persistEntry).not.toHaveBeenCalled()
  })

  it('the post_ledger_text tool refuses a forged fleet purchase', async () => {
    const tool = getTool('post_ledger_text')!
    const r = await tool.handler({ admin: s.m.admin, fundId: 'f', portfolioGroup: 'H200 SPV I', userId: 'u', access: { grants: {}, defaults: {}, features: {}, role: 'admin', vehicles: { all: true, ids: [] } } as any },
      { text: ledgerText('gpu-asset:a1:purchase'), status: 'posted' })
    expect(r.posted).toBe(0)
    expect(r.errors.join()).toMatch(/reserved/)
    expect(persistEntry).not.toHaveBeenCalled()
  })
})
