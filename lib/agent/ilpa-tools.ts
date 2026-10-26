// Handlers for the ILPA tools (ilpa-tools-manifest.ts).

import type { AgentToolContext, AgentToolHandler } from '@/lib/accounting/agent-tools'
import { loadCcdNotices } from '@/lib/ilpa/ccd-load'

export const ILPA_HANDLERS: Record<string, AgentToolHandler> = {
  ilpa_notice_data: async ({ admin, fundId, portfolioGroup }: AgentToolContext, input: { kind?: string; id?: string; lpEntityId?: string }) => {
    if (input?.kind !== 'capital_call' && input?.kind !== 'distribution') throw new Error('kind must be capital_call or distribution.')
    if (typeof input.id !== 'string' || !input.id) throw new Error('Which call or distribution? Pass its id.')
    const out = await loadCcdNotices(admin, fundId, portfolioGroup, input.kind, input.id, input.lpEntityId || null)
    if (!out.ok) throw new Error(out.error)
    return { vehicle: portfolioGroup, notices: out.notices }
  },
}
