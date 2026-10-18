import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { getUser } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { resolvePageAccess, canViewPage } from '@/lib/access/page-gate'
import { canSeeVehicle } from '@/lib/access/scope'
import { GPU_SPV_KIND } from '@/lib/vehicle-kinds'
import { AccountingBody, AccountingPageHeader } from '@/components/accounting-chrome'
import { FleetOverview, type FleetVehicle } from '@/components/gpu/fleet-overview'

export const metadata: Metadata = { title: 'GPU fleet' }

/**
 * ── GPU fleet (P5) ── Every GPU SPV the caller can see, firm-wide. Gated on `fleet` behind the
 * `gpu_fleet` switch, which ships off, so a VC-only fund never reaches it — admins included.
 */
export default async function FleetOverviewPage() {
  const user = await getUser()
  if (!user) redirect('/auth')

  const page = await resolvePageAccess(user.id)
  if (!page || !canViewPage(page, 'fleet', 'gpu_fleet')) redirect('/dashboard')

  const { data, error } = await (createAdminClient() as any)
    .from('fund_vehicles')
    .select('id, name, active')
    .eq('fund_id', page.fundId)
    .eq('kind', GPU_SPV_KIND)
    .order('active', { ascending: false })
    .order('name')
  // Only the caller's entities: a member scoped to some vehicles sees those alone. A failed query is
  // said, not shown as an empty fleet with an Add vehicle prompt.
  const vehicles: FleetVehicle[] = error ? [] : ((data ?? []) as FleetVehicle[]).filter(v => canSeeVehicle(page.access, v.id))

  return (
    <div className="px-4 md:pl-8 md:pr-4 pt-4 md:pt-8 pb-8 w-full">
      <AccountingPageHeader title="GPU fleet">
        Every GPU SPV, with the fleet&rsquo;s book value, revenue and utilization across them.
      </AccountingPageHeader>
      <AccountingBody>
        {error ? (
          <div role="alert" className="rounded-card border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
            Could not load the GPU SPVs. Reload the page to try again.
          </div>
        ) : (
          <FleetOverview vehicles={vehicles} />
        )}
      </AccountingBody>
    </div>
  )
}
