// Pure metadata for the LP LETTER tools. NO server imports (the Settings key UI lists these).
// Handlers live in letter-tools.ts; the functions they call in lib/lp-letters/service.ts, the same
// ones the LP Letters pages call.
//
// Access is the letters pages' own: LP relations, under the LP letters switch. A letter belongs to
// one entity, so a member scoped to some entities sees and writes only theirs.
//
// The assistant in the conversation can be the writer: lp_letter_data gives it the figures the
// fund's own generator works from, and lp_write_letter takes its company sections and rebuilds the
// table and the full draft around them, as generation does.

import type { AgentToolMeta } from '@/lib/accounting/agent-tools-manifest'

const LETTER = { type: 'string', description: 'The letter id, from lp_letters.' }
const base = { domain: 'lp' as const, accessDomain: 'lp_relations' as const, accessFeature: 'lp_letters' as const }

export const LETTER_TOOL_MANIFEST: AgentToolMeta[] = [
  {
    name: 'lp_letters',
    description: 'The fund\'s quarterly LP letters, newest first: period, entity and status (draft, generating, complete).',
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', properties: { vehicle: { type: 'string', description: 'Only this entity\'s letters.' } } },
  },
  {
    name: 'lp_letter',
    description: 'One LP letter: its full draft, its company sections (with company ids), and its prompt.',
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', properties: { letter_id: LETTER }, required: ['letter_id'] },
  },
  {
    name: 'lp_letter_data',
    description:
      'The figures a letter is written from: each company the entity holds (invested, fair value, MOIC, status, stage), ' +
      'its reported metrics for the quarter, and the fund totals. The same data the fund\'s letter generator uses. ' +
      'Use it to write the company sections for lp_write_letter.',
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', properties: { letter_id: LETTER }, required: ['letter_id'] },
  },
  {
    name: 'lp_letter_pdf',
    description:
      'A download link to an LP letter as a PDF, the same document LPs receive. The link works for an hour; give it to the user ' +
      'as a link, and call again rather than re-sharing an old one.',
    scope: 'read',
    ...base,
    inputSchema: { type: 'object', properties: { letter_id: LETTER }, required: ['letter_id'] },
  },
  {
    name: 'lp_create_letter',
    description: 'Start a draft LP letter for an entity and quarter. Then write it with lp_write_letter, or generate it on the LP Letters page.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object',
      properties: {
        vehicle: { type: 'string', description: 'The entity (portfolio_group) the letter is for.' },
        year: { type: 'integer' },
        quarter: { type: 'integer', minimum: 1, maximum: 4 },
        year_end: { type: 'boolean', description: 'Also the year-end letter.' },
        prompt: { type: 'string', description: 'Guidance kept with the letter for generating it.' },
      },
      required: ['vehicle', 'year', 'quarter'],
    },
  },
  {
    name: 'lp_write_letter',
    description:
      'Write an LP letter. sections replaces those companies\' updates (plain text, ids from lp_letter_data) and rebuilds the ' +
      'portfolio table and the full draft around them, as generating does. full_draft replaces the whole text instead, for ' +
      'edits such as the market commentary; pass it after sections, since sections rebuild the draft. Show the user the text ' +
      'before calling.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object',
      properties: {
        letter_id: LETTER,
        sections: {
          type: 'array',
          items: { type: 'object', properties: { company_id: { type: 'string' }, narrative: { type: 'string' } }, required: ['company_id', 'narrative'] },
        },
        full_draft: { type: 'string' },
        mark_complete: { type: 'boolean', description: 'Mark the letter complete.' },
      },
      required: ['letter_id'],
    },
  },
  {
    name: 'lp_share_letter',
    description:
      'Set which investors see an LP letter in their portal. The list replaces the current one; an empty list unshares it. ' +
      'Investors are names or ids. Admin only.',
    scope: 'write',
    ...base,
    inputSchema: {
      type: 'object',
      properties: { letter_id: LETTER, investors: { type: 'array', items: { type: 'string' } } },
      required: ['letter_id', 'investors'],
    },
  },
]
