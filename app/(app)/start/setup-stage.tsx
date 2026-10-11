'use client'

import { createContext, useContext } from 'react'

/**
 * How many companies the fund holds, as the caller's own RLS lets them count it — or null when it
 * could not be read. Provided by ./layout.tsx so the client Start page can tell a brand-new fund
 * (offer setup prompts) from one with a portfolio to ask about. See lib/start/quick-actions.ts.
 */
const CompanyCountContext = createContext<number | null>(null)

export function CompanyCountProvider({ count, children }: { count: number | null; children: React.ReactNode }) {
  return <CompanyCountContext.Provider value={count}>{children}</CompanyCountContext.Provider>
}

export function useCompanyCount(): number | null {
  return useContext(CompanyCountContext)
}
