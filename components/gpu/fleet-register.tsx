'use client'

import { Plus } from 'lucide-react'
import { HeaderTable, PendingAction, ShellSection } from './parts'

// ── GPU fleet (P5) ── The fleet register: one row per server, with what it cost and what it is worth
// on the books now. Wired to the asset routes in P5-2.

const COLUMNS = [
  { label: 'Asset' },
  { label: 'Type' },
  { label: 'GPUs', align: 'right' as const },
  { label: 'Status' },
  { label: 'In service' },
  { label: 'Cost', align: 'right' as const },
  { label: 'NBV', align: 'right' as const },
]

export function FleetRegister(_props: { vehicle: string; vehicleId: string | null }) {
  return (
    <ShellSection
      title="Assets"
      description="Net book value is cost less accumulated depreciation, from the ledger."
      action={<PendingAction label="Add asset" icon={Plus} hint="Assets are added once the asset model ships (P5-2)." />}
    >
      <HeaderTable columns={COLUMNS}>
        No assets yet. The register fills in once the asset model ships.
      </HeaderTable>
    </ShellSection>
  )
}
