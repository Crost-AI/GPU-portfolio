import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { AssetDetail } from '@/components/gpu/asset-detail'

export const metadata: Metadata = { title: 'Asset' }

/** ── GPU fleet (P5) ── One server in the fleet register. A GPU SPV's page only. */
export default async function AssetPage(props: { params: Promise<{ id: string; assetId: string }> }) {
  const params = await props.params
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id, { domain: 'fleet', feature: 'gpu_fleet', kinds: ['gpu_spv'] })
  const assetId = decodeURIComponent(params.assetId)
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Asset"
        description="Specs, depreciation and net book value, listings, monthly revenue and utilization, events and documents"
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <AssetDetail vehicle={vehicle} vehicleId={vehicleId} assetId={assetId} />
      </FundSubpageChrome>
    </div>
  )
}
