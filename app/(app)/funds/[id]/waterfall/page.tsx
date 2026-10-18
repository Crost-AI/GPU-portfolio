import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { canViewPage } from '@/lib/access/page-gate'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { WaterfallView } from '@/components/gpu/waterfall-view'

export const metadata: Metadata = { title: 'Waterfall & distributions' }

/**
 * ── GPU fleet (P5) ── The distributable-cash waterfall: preferred return, capital returned, and the
 * distributions declared through it. Investors' capital, so `lp_capital`; the terms (the manager's
 * share) are `gp_economics` and the view shows them only to a caller who has it. A GPU SPV's page
 * only, and nothing while `gpu_fleet` is off.
 */
export default async function WaterfallPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const { vehicle, vehicleId, page } = await requireVehicleAccess(params.id, { domain: 'lp_capital', feature: 'gpu_fleet', kinds: ['gpu_spv'] })
  // The gate asks lp_capital under the GPU switch; the distributions route this page reads asks it
  // under lp_capital's own (`lps`). Both, or the page renders around a request that 403s.
  if (!canViewPage(page, 'lp_capital')) redirect('/funds')
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Waterfall & distributions"
        description="Preferred return, capital returned and unreturned, and distributions declared through the waterfall"
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <WaterfallView vehicle={vehicle} vehicleId={vehicleId} />
      </FundSubpageChrome>
    </div>
  )
}
