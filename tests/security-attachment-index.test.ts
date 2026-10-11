import { describe, it, expect, vi } from 'vitest'
import { NextRequest } from 'next/server'

/**
 * `parseInt('0.png')` is 0, so `/api/emails/<id>/attachment/0.png` used to serve attachment 0 —
 * the shape of path an over-broad proxy matcher let skip the API gate. Only plain 1-2 digit indexes.
 */
const touched = vi.hoisted(() => ({ emails: 0, rpc: 0 }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'u' } } }) },
    rpc: async () => { touched.rpc++; return { data: null, error: { message: 'not found' } } },
  }),
}))
vi.mock('@/lib/api-helpers', () => ({ assertWriteAccess: async () => ({ fundId: 'f' }) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: (t: string) => {
      const q: any = {
        select: () => q, eq: () => q,
        maybeSingle: async () => {
          if (t === 'inbound_emails') { touched.emails++; return { data: null } }
          return { data: { fund_id: 'f' } }
        },
      }
      return q
    },
  }),
}))
import { GET, DELETE } from '@/app/api/emails/[id]/attachment/[index]/route'

const call = (fn: typeof GET, index: string) =>
  fn(new NextRequest(`http://x/api/emails/e1/attachment/${index}`), { params: Promise.resolve({ id: 'e1', index }) })

describe('attachment index', () => {
  it.each(['0.png', '1.svg', '0x1', '1e1', '-1', ' 1', '100', '', '01a'])('400s on %j without touching the email', async index => {
    const before = { ...touched }
    expect((await call(GET, index)).status).toBe(400)
    expect((await call(DELETE, index)).status).toBe(400)
    expect(touched).toEqual(before)
  })

  it('accepts a plain index', async () => {
    expect((await call(GET, '0')).status).toBe(404) // reached the lookup; the stub has no email
    expect((await call(DELETE, '12')).status).toBe(404)
  })
})
