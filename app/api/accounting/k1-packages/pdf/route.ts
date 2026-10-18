import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { refuseWithoutCarryAccess } from '@/lib/tax/access'
import { assertReadAccess } from '@/lib/api-helpers'
import { rateLimit } from '@/lib/rate-limit'
import { k1Document } from '@/lib/reports/documents'
import { assertK1PackageVisible } from '@/lib/accounting/vehicle-visibility'
import { refuseGpuSpvTax } from '@/lib/accounting/vehicle-domain'

// One partner's K-1 figures as a PDF.
//
// GP-side. The portal serves the same document to the partner through the delivery record, which
// is where consent is checked — this route is the manager looking at, or printing, what will be
// furnished.

export async function GET(req: NextRequest) {
  const supabase = await createClient()
  const admin = createAdminClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const gate = await assertReadAccess(admin, user.id)
  if (gate instanceof NextResponse) return gate
  // Per-partner K-1 figures include the GP's — see lib/tax/access.ts.
  const carryGate = await refuseWithoutCarryAccess(admin, gate, user.id)
  if (carryGate) return carryGate

  const limited = await rateLimit({ key: `k1-pdf:${user.id}`, limit: 60, windowSeconds: 300 })
  if (limited) return limited

  const packageId = req.nextUrl.searchParams.get('packageId')
  const lpEntityId = req.nextUrl.searchParams.get('lpEntityId')
  if (!packageId || !lpEntityId) {
    return NextResponse.json({ error: 'packageId and lpEntityId are required' }, { status: 400 })
  }
  const hiddenPackage = await assertK1PackageVisible(admin, gate, packageId)
  if (hiddenPackage) return hiddenPackage
  const gpuTax = await refuseGpuSpvTax(admin, gate.fundId, { packageId })
  if (gpuTax) return gpuTax

  const doc = await k1Document(admin, gate.fundId, packageId, lpEntityId)
  if (!doc) return NextResponse.json({ error: 'Partner not in this package' }, { status: 404 })

  return new NextResponse(new Uint8Array(doc.body), {
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${doc.fileName}"`,
    },
  })
}
