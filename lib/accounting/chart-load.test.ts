import { describe, it, expect } from 'vitest'
import { memoryAdmin } from '@/tests/helpers/memory-admin'
import { loadChart } from './chart-load'

const VEHICLES = [{ id: 'v1', fund_id: 'f1', name: 'Fund I', aliases: [] }]
const id = (i: number) => `a${String(i).padStart(5, '0')}`

describe('loadChart', () => {
  it('maps rows to the Account shape loadPostedLedger uses, scoped to the vehicle', async () => {
    const { admin } = memoryAdmin({
      fund_vehicles: VEHICLES,
      chart_of_accounts: [
        { id: 'a1', fund_id: 'f1', vehicle_id: 'v1', code: '3100', name: 'LP capital — Acme', type: 'equity', subtype: 'lp_capital', lp_entity_id: 'lp1', company_id: null },
        { id: 'a2', fund_id: 'f1', vehicle_id: 'v1', code: '1500', name: 'Investment — Co', type: 'asset', subtype: null, lp_entity_id: null, company_id: 'c1' },
        { id: 'a3', fund_id: 'f1', vehicle_id: 'v2', code: '1000', name: 'Other fund cash', type: 'asset' },
      ],
    })
    expect(await loadChart(admin, 'f1', 'Fund I')).toEqual([
      { id: 'a1', fundId: 'f1', code: '3100', name: 'LP capital — Acme', type: 'equity', subtype: 'lp_capital', lpEntityId: 'lp1', companyId: null },
      { id: 'a2', fundId: 'f1', code: '1500', name: 'Investment — Co', type: 'asset', subtype: null, lpEntityId: null, companyId: 'c1' },
    ])
  })

  it('pages past the 1000-row cap in a stable id order', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: id(1500 - i), fund_id: 'f1', vehicle_id: 'v1', code: String(i), name: 'x', type: 'asset' }))
    const { admin } = memoryAdmin({ fund_vehicles: VEHICLES, chart_of_accounts: rows }, { maxRows: 1000 })
    const ids = (await loadChart(admin, 'f1', 'Fund I')).map(a => a.id)
    expect(ids).toHaveLength(1500)
    expect(ids).toEqual(Array.from({ length: 1500 }, (_, i) => id(i + 1)))
  })

  it('throws on a failed read rather than returning an empty chart', async () => {
    const m = memoryAdmin({ fund_vehicles: VEHICLES, chart_of_accounts: [] })
    m.failNext('chart_of_accounts', 'select', 'boom')
    await expect(loadChart(m.admin, 'f1', 'Fund I')).rejects.toMatchObject({ message: 'boom' })
  })

  it('is empty for a name with no registry row', async () => {
    const { admin } = memoryAdmin({ fund_vehicles: VEHICLES, chart_of_accounts: [{ id: 'a1', fund_id: 'f1', vehicle_id: 'v1', code: '1000' }] })
    expect(await loadChart(admin, 'f1', 'Nope')).toEqual([])
  })
})
