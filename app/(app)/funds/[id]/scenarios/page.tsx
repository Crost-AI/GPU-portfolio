import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { canViewPage } from '@/lib/access/page-gate'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { ScenariosView } from '@/components/gpu/scenarios-view'

export const metadata: Metadata = { title: 'Scenarios' }

/**
 * ── GPU fleet (P5) ── The pitch scenarios side by side. A plan over the books, so `accounting`, and
 * nothing while `gpu_fleet` is off.
 */
export default async function ScenariosPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const { vehicle, vehicleId, page } = await requireVehicleAccess(params.id, { feature: 'gpu_fleet', kinds: ['gpu_spv'] })
  // The gate asks the books under the GPU switch; the forecast routes ask them under `accounting`'s.
  if (!canViewPage(page, 'accounting')) redirect('/funds')
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Scenarios"
        description="The pitch scenarios side by side: utilization, investor and project returns, and when capital comes back"
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <ScenariosView vehicle={vehicle} vehicleId={vehicleId} />
      </FundSubpageChrome>
    </div>
  )
}
