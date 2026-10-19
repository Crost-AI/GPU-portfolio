import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { RevenueView } from '@/components/gpu/revenue-view'

export const metadata: Metadata = { title: 'Revenue & payouts' }

/** ── GPU fleet (P5) ── Revenue entered per asset per period, and the payouts. A GPU SPV's page only. */
export default async function RevenuePage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id, { domain: 'fleet', feature: 'gpu_fleet', kinds: ['gpu_spv'] })
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Revenue & payouts"
        description="Rental revenue, GPU-hours and marketplace fees entered per asset per period, and the payouts that settle them"
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <RevenueView vehicle={vehicle} vehicleId={vehicleId} />
      </FundSubpageChrome>
    </div>
  )
}
