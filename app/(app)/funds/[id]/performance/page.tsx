import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { FundPerformanceView } from '../../performance/view'

export const metadata: Metadata = { title: 'Fund performance' }

export default async function FundPerformancePage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id)
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Fund performance"
        description="LP-only contributions, distributions and returns through a date, from the books"
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <FundPerformanceView />
      </FundSubpageChrome>
    </div>
  )
}
