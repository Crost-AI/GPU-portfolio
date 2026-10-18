import type { Metadata } from 'next'
import { requireVehicleAccess } from '../../guard'
import { FundSubpageChrome } from '@/components/fund-subpage-chrome'
import { FleetRegister } from '@/components/gpu/fleet-register'

export const metadata: Metadata = { title: 'Fleet' }

/** ── GPU fleet (P5) ── The fleet register. A GPU SPV's page only: any other entity is not found. */
export default async function FleetPage(props: { params: Promise<{ id: string }> }) {
  const params = await props.params
  const { vehicle, vehicleId } = await requireVehicleAccess(params.id, { domain: 'fleet', feature: 'gpu_fleet', kinds: ['gpu_spv'] })
  return (
    <div className="pt-4 md:pt-8 pb-8 w-full">
      <FundSubpageChrome
        title="Fleet"
        description="The servers the vehicle owns: type, GPUs, status, in-service date, cost and net book value"
        vehicle={vehicle}
        vehicleId={vehicleId}
      >
        <FleetRegister vehicle={vehicle} vehicleId={vehicleId} />
      </FundSubpageChrome>
    </div>
  )
}
