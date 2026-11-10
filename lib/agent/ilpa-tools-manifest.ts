// Pure metadata for the ILPA tools. NO server imports (the Settings key UI lists these). Handlers
// live in ilpa-tools.ts.
//
// One vehicle's books, so it binds as a ledger tool: the dispatcher resolves the vehicle with the
// caller's access and injects it.
//
//   ilpa_notice_data  → an issued call or declared distribution as the ILPA Capital Call &
//                       Distribution Template (v. 2.0) data, per partner; writes nothing
//
// The mechanics are in lib/ilpa/ccd-load.ts, the same data the notice's .xlsx download carries.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

export const ILPA_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'ilpa_notice_data',
    description:
      "An issued capital call or declared distribution as the data the ILPA Capital Call & Distribution Template " +
      '(v. 2.0) asks for, one notice per partner: the fund and partner blocks (fund size, GP commitment, the partner\'s ' +
      'commitment and percentage), each line under its ILPA transaction type with its impact on unfunded commitment and ' +
      'whether it is inside or outside the fund, cumulative amounts before and including the notice, the unfunded ' +
      'commitment roll, and footnotes. Writes nothing. The same data downloads as .xlsx beside each notice on the ' +
      'capital accounts page.',
    scope: 'read',
    accessDomain: 'lp_capital',
    inputSchema: {
      type: 'object',
      required: ['kind', 'id'],
      properties: {
        kind: { type: 'string', enum: ['capital_call', 'distribution'] },
        id: { type: 'string', description: 'The call or distribution (lp_capital_calls lists calls).' },
        lpEntityId: { type: 'string', description: 'One partner only. Leave out for every partner on the notice.' },
      },
    },
  },
]
