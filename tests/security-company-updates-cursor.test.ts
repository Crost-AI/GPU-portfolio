import { describe, it, expect } from 'vitest'
import { encodeCursor, isCursorTimestamp, listCompanyUpdates, SearchParamsError } from '@/lib/company-updates/search'

/**
 * The timeline cursor's received_at and id are interpolated into a PostgREST `or=` filter. Anything
 * but a timestamp and a uuid could add clauses to it.
 */
const ID = '00000000-0000-4000-8000-000000000001'

function fakeAdmin(seen: string[]) {
  const q: any = new Proxy({}, {
    get: (_t, prop) => {
      if (prop === 'then') return (res: any) => res({ data: [], error: null })
      if (prop === 'or') return (f: string) => { seen.push(f); return q }
      return () => q
    },
  })
  return { from: () => q } as any
}

describe('company updates cursor', () => {
  it.each([
    '2026-10-01T12:00:00Z',
    '2026-10-01T12:00:00.123456+00:00',
    '2026-10-01 12:00:00.1+00:00',
  ])('accepts timestamp %s', ts => {
    expect(isCursorTimestamp(ts)).toBe(true)
  })

  it.each([
    '',
    '2026-10-01T12:00:00Z,id.gt.0',
    '2026-10-01),fund_id.neq.(x',
    'now()',
    '2026-13-45T99:99:99Z',
  ])('rejects timestamp %j', ts => {
    expect(isCursorTimestamp(ts)).toBe(false)
  })

  it('refuses a cursor carrying filter syntax before it reaches .or()', async () => {
    const seen: string[] = []
    const bad = encodeCursor({ received_at: '2026-10-01T00:00:00Z,fund_id.neq.x', id: ID })
    await expect(listCompanyUpdates(fakeAdmin(seen), { fundId: 'f', companyId: 'c', cursor: bad }))
      .rejects.toBeInstanceOf(SearchParamsError)
    const nonString = encodeCursor({ received_at: 12345, id: ID })
    await expect(listCompanyUpdates(fakeAdmin(seen), { fundId: 'f', companyId: 'c', cursor: nonString }))
      .rejects.toBeInstanceOf(SearchParamsError)
    expect(seen).toEqual([])
  })

  it('passes a well-formed cursor through unchanged (microseconds kept)', async () => {
    const seen: string[] = []
    const ts = '2026-10-01T12:00:00.123456+00:00'
    await listCompanyUpdates(fakeAdmin(seen), { fundId: 'f', companyId: 'c', cursor: encodeCursor({ received_at: ts, id: ID }) })
    expect(seen).toEqual([`received_at.lt.${ts},and(received_at.eq.${ts},id.lt.${ID})`])
  })
})
