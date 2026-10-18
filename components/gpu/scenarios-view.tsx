'use client'

import { Sparkles } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'
import { PendingAction, ShellSection } from './parts'

// ── GPU fleet (P5) ── The six pitch scenarios side by side, with the rows of the model pack's
// "Headline results at a glance". Every cell is a dash until the scenario engine is wired (P5-5).

const SCENARIOS = ['Base case', 'Balanced', 'Demand-led', 'Oversupply', 'Oversupply 60%', 'Oversupply 50%']
const ROWS = [
  'Utilization',
  'Investor multiple (after fees)',
  'Investor IRR (after fees)',
  'Project multiple (before fees)',
  'Project IRR (before fees)',
  'Capital recovered (project basis)',
  'Total cash to investors, 5 yrs',
]

export function ScenariosView(_props: { vehicle: string; vehicleId: string | null }) {
  return (
    <div className="space-y-4">
      <ShellSection
        title="Headline comparison"
        description="Six scenarios that differ only in the price path and utilization."
        action={<PendingAction label="Create pitch scenarios" icon={Sparkles} hint="Seeding the six scenarios arrives with the scenario engine (P5-5)." />}
      >
        <div className="overflow-x-auto rounded-card border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-left font-medium"><span className="sr-only">Measure</span></th>
                {SCENARIOS.map(s => <th key={s} scope="col" className="whitespace-nowrap px-3 py-2 text-right font-medium">{s}</th>)}
              </tr>
            </thead>
            <tbody>
              {ROWS.map(r => (
                <tr key={r} className="border-t">
                  <th scope="row" className="whitespace-nowrap px-3 py-2 text-left font-normal">{r}</th>
                  {SCENARIOS.map(s => <td key={s} className="px-3 py-2 text-right tabular-nums text-muted-foreground">&mdash;</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ShellSection>

      <EmptyState>No scenarios yet. Create the pitch scenarios to compare them here.</EmptyState>
    </div>
  )
}
