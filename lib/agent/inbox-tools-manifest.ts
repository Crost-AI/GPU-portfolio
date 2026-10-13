// The inbox an assistant clears when the fund has no server AI key (lib/ai/keyless.ts): emailed
// company updates the pipeline saved but could not read. Spread into the portfolio manifest, so
// they gate and dispatch exactly like the other portfolio tools.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const EMAIL = { type: 'string', description: 'The email id, from inbox_waiting.' }

export const INBOX_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'inbox_waiting',
    description:
      'Company updates that arrived by email (or were submitted from chat) and are waiting for you: this fund has no server AI key, ' +
      'so the app saved them without reading them. Read each with inbox_read, record its figures with record_metric_value ' +
      '(and notes with add_company_note), then mark it with inbox_done.',
    scope: 'read',
    domain: 'portfolio',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '1-50, default 20.' } } },
  },
  {
    name: 'inbox_read',
    description:
      'One waiting update in full: sender, subject, body and the text of each attachment. A scanned PDF or an image has no text ' +
      'here; say so rather than guessing at it.',
    scope: 'read',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: { email: EMAIL, max_chars: { type: 'number', description: 'Character budget for the text (2000-60000; default 30000).' } },
      required: ['email'],
    },
  },
  {
    name: 'inbox_done',
    description:
      'Mark a waiting update as handled, once its figures are recorded: files it under the company, so it shows on the company\'s ' +
      'updates and leaves the waiting list. Pass recorded: 0 when there was nothing to record.',
    scope: 'write',
    domain: 'portfolio',
    inputSchema: {
      type: 'object',
      properties: {
        email: EMAIL,
        company: { type: 'string', description: 'Company id, or the company name.' },
        recorded: { type: 'number', description: 'How many metric values you recorded from it.' },
      },
      required: ['email', 'company'],
    },
  },
]
