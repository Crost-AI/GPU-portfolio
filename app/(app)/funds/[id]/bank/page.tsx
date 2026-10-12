import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { BankView } from '../../bank/view'

export const metadata: Metadata = { title: 'Bank transactions' }

export default async function BankPage(props: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await props.params;
  // The firm-wide bank queue links a row here with ?q=<its description>, so it opens found.
  const q = (await props.searchParams).q
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id)
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Bank transactions"
        description="Import bank transactions and post to the journal"
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <BankView initialSearch={typeof q === 'string' ? q : ''} />
      </FundSubpageChrome>
    </div>
  )
}
