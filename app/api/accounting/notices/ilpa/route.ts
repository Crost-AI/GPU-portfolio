import { NextRequest, NextResponse } from 'next/server'
import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
// lp_capital domain (lib/access/route-domains.ts): a read of the register, sent to no one.
import { assertReadAccess } from '@/lib/api-helpers'
import { resolveGroupOr400 } from '@/lib/accounting/http-vehicle'
import { rateLimit } from '@/lib/rate-limit'
import { loadCcdNotices } from '@/lib/ilpa/ccd-load'
import { ccdSheetRows } from '@/lib/ilpa/ccd'

export const runtime = 'nodejs'

// GET ?group=&kind=capital_call|distribution&id=&lp=&format=xlsx|json
//
// An issued call or declared distribution as the data the ILPA Capital Call & Distribution Template
// (v. 2.0) asks for, in this app's own layout and under ILPA's field names: one sheet per partner
// (or just `lp`), or the same data as JSON. Built from the
// notice register, so it restates exactly what each partner's notice PDF does.
export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  const sp = req.nextUrl.searchParams
  const group = await resolveGroupOr400(admin, gate, sp.get('group'))
  if (group instanceof NextResponse) return group

  const limited = await rateLimit({ key: `ilpa-ccd:${user.id}`, limit: 30, windowSeconds: 300 })
  if (limited) return limited

  const kind = sp.get('kind')
  if (kind !== 'capital_call' && kind !== 'distribution') return NextResponse.json({ error: 'kind must be capital_call or distribution' }, { status: 400 })
  const id = sp.get('id') ?? ''
  if (!id) return NextResponse.json({ error: 'id is required' }, { status: 400 })

  const out = await loadCcdNotices(admin, gate.fundId, group, kind, id, sp.get('lp'))
  if (!out.ok) return NextResponse.json({ error: out.error }, { status: out.status })

  if (sp.get('format') === 'json') {
    return NextResponse.json({ notices: out.notices }, { headers: { 'Cache-Control': 'private, no-store' } })
  }

  const wb = XLSX.utils.book_new()
  const used = new Set<string>()
  for (const n of out.notices) {
    const base = n.lp.name.replace(/[\[\]:*?/\\]/g, ' ').trim().slice(0, 28) || 'Partner'
    let name = base
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 26)} ${i}`
    used.add(name.toLowerCase())
    const ws = XLSX.utils.aoa_to_sheet(ccdSheetRows(n))
    ws['!cols'] = [{ wch: 70 }, { wch: 60 }, { wch: 16 }, { wch: 28 }, { wch: 20 }, { wch: 22 }, { wch: 18 }]
    XLSX.utils.book_append_sheet(wb, ws, name)
  }
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
  return new NextResponse(buf, {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${out.fileStem}.xlsx"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
