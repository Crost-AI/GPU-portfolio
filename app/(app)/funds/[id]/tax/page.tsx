import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { TaxView } from '../../tax/view'
import { isGpuSpv } from '@/lib/vehicle-kinds'

export const metadata: Metadata = { title: 'Tax' }

/**
 * The year's tax work for an entity. Gated on the Tax area AND the tax_reporting
 * feature — the entity gate takes the feature for exactly this reason: every route behind this
 * page is gated on it, and a page of 403s is worse than a redirect. The entity's own grant is
 * checked there too, so a management company still needs `management_company`.
 */
export default async function TaxPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const { vehicle, vehicleId, kind } = await requireVehicleAccess(params.id, { domain: 'tax', feature: 'tax_reporting' })
  // ── GPU fleet (P1) ── every tax route refuses a GPU SPV until #68, so the page would be all 409s.
  if (isGpuSpv(kind)) notFound()
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Tax"
        description="The year's book-to-tax adjustments, adjusting entries, K-1 package, partner tax forms, and the tax package for the preparer."
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <TaxView />
      </FundSubpageChrome>
    </div>
  )
}
