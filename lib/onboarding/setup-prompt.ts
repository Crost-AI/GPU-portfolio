/**
 * The setup prompt: what an admin pastes into Claude or ChatGPT (or picks from the MCP prompt
 * menu as "Set up this fund") to set a fund up from chat. One copy, served as an MCP prompt
 * (lib/agent/getting-started.ts) and printed in DOCS.md, so the two cannot drift.
 * tests/fund-setup.test.ts checks the docs carry this text.
 */
export const SETUP_PROMPT = [
  'Help me set up this fund. First call setup_status and tell me in a few lines where things stand.',
  '',
  'Then ask me, one short question at a time, only for what is missing:',
  '1. What we will run here: portfolio tracking, fund books, LP capital and the investor portal, deal flow and diligence, management company books.',
  '2. Our entities: each fund, SPV or management company, with its vintage year.',
  '3. The team: each person\'s email; whether they are an admin (admins approve deletes, capital calls, distributions, anything sent to LPs, and finalizing K-1s) or a member; which preset fits each member (CFO, fund administrator, tax preparer, auditor, investment team, investor relations); which entities they should see; and an end date for anyone here for one engagement, like an auditor or tax preparer.',
  '4. Who emails us company updates, so those addresses can be authorized.',
  '5. How AI should work here. If there is no server AI key, tell me in a few lines what you can do for me in chat without one and what needs a key (setup_status lists both), and ask whether to run without a key.',
  '',
  'Then show me the whole plan as a short list. Once I confirm, apply it with one setup_fund call. Tell me what was created and any warnings, call setup_status again, and walk me through the next open steps: partners and commitments (add_partner), investments (record_investment), opening balances (post_ledger_text) and the first close (close_period).',
  '',
  'Never ask me for API keys or passwords. If a step needs one, tell me where to add it in Settings.',
].join('\n')
