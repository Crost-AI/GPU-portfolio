import type { AgentToolHandler } from '@/lib/accounting/agent-tools'
import { getConstructionModel } from '@/lib/accounting/construction-service'
import { executeUpdatePortfolioConstruction } from '@/lib/pending-actions/construction'

export const CONSTRUCTION_HANDLERS: Record<string, AgentToolHandler> = {
  portfolio_construction: async ({ admin, fundId, access }, input) => {
    if (typeof input?.vehicle !== 'string' || !input.vehicle.trim()) {
      throw new Error('vehicle is required')
    }
    return getConstructionModel({ admin, fundId, access }, { vehicle: input.vehicle, ...(typeof input.planId === 'string' && input.planId ? { planId: input.planId } : {}) })
  },
  // Direct, for an agent with write access: the same change the Analyst stages, applied now.
  portfolio_construction_update: async ({ admin, fundId, userId, access }, input) => {
    if (typeof input?.vehicle !== 'string' || !input.vehicle.trim()) throw new Error('vehicle is required')
    return executeUpdatePortfolioConstruction({ admin, fundId, userId: userId ?? '', access }, input)
  },
}
