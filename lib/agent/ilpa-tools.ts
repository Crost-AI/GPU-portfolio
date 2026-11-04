// Handlers for the ILPA tools (ilpa-tools-manifest.ts).

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { loadCcdNotices } from '@/lib/ilpa/ccd-load'
import { seesIndividualCarry } from '@/lib/access/carry-visibility'

export const ILPA_HANDLERS: Record<string, AgentToolHandler> = {
  ilpa_notice_data: async ({ admin, fundId, portfolioGroup, access }: AgentToolContext, input: { kind?: string; id?: string; lpEntityId?: string }) => {
    if (input?.kind !== 'capital_call' && input?.kind !== 'distribution') throw new Error('kind must be capital_call or distribution.')
    if (typeof input.id !== 'string' || !input.id) throw new Error('Which call or distribution? Pass its id.')
    // Gated on lp_capital; a distribution's carry lines are GP economics (Crost #87).
    const out = await loadCcdNotices(admin, fundId, portfolioGroup, input.kind, input.id, input.lpEntityId || null, seesIndividualCarry(access))
    if (!out.ok) throw new Error(out.error)
    return { vehicle: portfolioGroup, notices: out.notices }
  },
}
