import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { ScenariosView } from '@/components/gpu/scenarios-view'

export const metadata: Metadata = { title: 'Scenarios' }

/** ── GPU fleet (P5) ── The pitch scenarios side by side. A plan over the books, so `accounting`. */
export default async function ScenariosPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id, { kinds: ['gpu_spv'] })
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
