import { describe, expect, it } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { getTool } from '@/lib/accounting/agent-tools'

// ── GPU fleet (P1) ── Tax fails closed on a GPU SPV (refuseGpuSpvTax, #68). The tax routes refuse it;
// the agent's tax tools (upstream #130, #170) call the same functions without a route in front, so
// they must refuse it themselves, before reading or writing anything.

const TAX_TOOLS = ['holding_k_ones', 'mark_holding_k_one', 'tax_adjustments', 'post_tax_adjustments']

const ctx = (admin: any, portfolioGroup: string) => ({ admin, fundId: 'f', portfolioGroup, userId: 'u', access: {} as any })

describe('agent tax tools on a GPU SPV', () => {
  it.each(TAX_TOOLS)('%s refuses a GPU SPV and writes nothing', async (name) => {
    const m = memoryAdmin({ fund_vehicles: [{ id: 'v-gpu', fund_id: 'f', name: 'GPU SPV I', kind: 'gpu_spv', aliases: [] }] })
    await expect(getTool(name)!.handler(ctx(m.admin, 'GPU SPV I'), { taxYear: 2026 }))
      .rejects.toThrow('Tax reporting is not yet supported for GPU SPVs')
    expect(m.tables.journal_entries ?? []).toEqual([])
    expect(m.tables.received_k1s ?? []).toEqual([])
  })
})
