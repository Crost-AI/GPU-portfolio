// A GPU SPV's book NAV, for the accrued profit-share memo (lib/gpu/accrued.ts): what the vehicle
// would have to distribute if it wound up on its books today (Karl, update 2026-10-19).
//
//   cash (1000, 1050)  − the distribution reserve held back
//   − what it owes: credit balances on 2000 payables, 2100 due to manager, 2300 distributions
//     payable and 2900 due to affiliates (and their sub-accounts)
//   + equipment at net book value (1600 − 1650)
//
// Receivables, prepaids and deposits are left out, as Karl's definition leaves them out. Pure.

import { roundCents } from '@/lib/accounting/ledger'
import type { Account, Posting } from '@/lib/accounting/types'

const CASH = new Set(['1000', '1050'])
const OWED = new Set(['2000', '2100', '2300', '2900'])
const EQUIPMENT = new Set(['1600', '1650'])

export interface GpuBookNav {
  cash: number
  reserve: number
  owed: number
  /** 1600 − 1650. */
  equipment: number
  bookNav: number
}

export function gpuBookNav(accounts: Account[], postings: Posting[], reserve: number): GpuBookNav {
  const balance = new Map<string, number>()
  for (const p of postings) balance.set(p.accountId, (balance.get(p.accountId) ?? 0) + p.amount)
  let cash = 0, owed = 0, equipment = 0
  for (const a of accounts) {
    if (a.lpEntityId) continue
    const base = a.code.split('-')[0]
    const b = balance.get(a.id) ?? 0
    if (CASH.has(base) && !a.code.includes('-')) cash += b
    else if (OWED.has(base) && a.type === 'liability') owed += Math.max(0, -b)
    else if (EQUIPMENT.has(base)) equipment += b
  }
  const r = Math.max(0, roundCents(reserve))
  return {
    cash: roundCents(cash), reserve: r, owed: roundCents(owed), equipment: roundCents(equipment),
    bookNav: roundCents(cash - r - owed + equipment),
  }
}
