import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { PartnershipExpensesView } from '../../partnership-expenses/view'

export const metadata: Metadata = { title: 'Partnership expenses' }

export default async function PartnershipExpensesPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id)
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Partnership expenses"
        description="The quarterly invoices that bill the funds for the expenses this entity paid for them."
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <PartnershipExpensesView />
      </FundSubpageChrome>
    </div>
  )
}
