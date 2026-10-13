// Set up a fund on a fresh deploy without opening the web app.
//
// Creates (or reuses) your account, lets it past the signup allow-list, creates the fund with you
// as its admin and agent access on, and prints an API key for the agent API and MCP. Everything
// after that (products, entities, team, senders) is one call to the `setup_fund` tool, from Claude
// or from a script: see "Setting up a fund with Claude, ChatGPT or a script" in DOCS.md.
//
//   npm run bootstrap -- --email you@firm.com --fund "Hemrock Ventures" \
//     [--products portfolio_reporting,fund_operations,lp_reporting] [--ai assistant|key] [--no-key]
//
// --ai assistant runs the fund with no server AI key: your own assistant (Claude, ChatGPT) does the
// AI work over MCP. --ai key requires a provider key in the environment (below). Either way the
// script prints what works without a key and what needs one (lib/ai/capabilities.ts).
//
// Reads NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and ENCRYPTION_KEY from .env.local.
// An AI provider key, if you want one stored, comes from ANTHROPIC_API_KEY, OPENAI_API_KEY or
// OPENROUTER_API_KEY in the environment, never from the command line, so it stays out of your
// shell history. Safe to re-run: an existing account and fund are reused, and a new key is minted.

import { createAdminClient } from '../lib/supabase/admin'
import { createFund, fundCreationRefusal, type AIKeyInput } from '../lib/onboarding/create-fund'
import { applySetupPlan, parseSetupPlan } from '../lib/onboarding/setup-plan'
import { generateApiKey } from '../lib/accounting/api-keys'
import { siteOrigin } from '../lib/site-links'
import { AI_CAPABILITIES, hasAnyAIKey } from '../lib/ai/capabilities'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

function aiKeyFromEnv(): AIKeyInput | null {
  if (process.env.ANTHROPIC_API_KEY) return { provider: 'anthropic', key: process.env.ANTHROPIC_API_KEY }
  if (process.env.OPENAI_API_KEY) return { provider: 'openai', key: process.env.OPENAI_API_KEY }
  if (process.env.OPENROUTER_API_KEY) return { provider: 'openrouter', key: process.env.OPENROUTER_API_KEY }
  return null
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

async function main() {
  const email = arg('email')?.trim().toLowerCase()
  const fundName = arg('fund')?.trim()
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail('Pass --email you@firm.com')
  const aiChoice = arg('ai')
  if (aiChoice !== undefined && aiChoice !== 'assistant' && aiChoice !== 'key') fail('--ai is "assistant" (no server key) or "key".')
  const aiKey = aiChoice === 'assistant' ? null : aiKeyFromEnv()
  if (aiChoice === 'key' && !aiKey) fail('--ai key needs ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY in the environment.')
  const admin = createAdminClient()
  const db = admin as any

  // 1. Past the signup gate (hook_before_user_created), so this address can exist and sign in later.
  const { error: allowError } = await db.from('allowed_signups').insert({ email_pattern: email })
  if (allowError && allowError.code !== '23505') fail(`Could not add ${email} to the signup allow-list: ${allowError.message}`)

  // 2. The account. Confirmed, with no password: sign in to the web app later with a magic link.
  let userId: string | undefined
  for (let page = 1; page <= 20 && !userId; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) fail(`Could not list users: ${error.message}`)
    userId = data.users.find(u => u.email?.toLowerCase() === email)?.id
    if (data.users.length < 1000) break
  }
  if (userId) {
    console.log(`Using the existing account ${email}.`)
  } else {
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true })
    if (error || !data.user) fail(`Could not create the account: ${error?.message}`)
    userId = data.user.id
    console.log(`Created the account ${email}.`)
  }

  // 3. The fund: reused if they already run one, created otherwise.
  let fundId: string
  const { data: membership } = await db.from('fund_members').select('fund_id, role').eq('user_id', userId).maybeSingle()
  if (membership) {
    if (membership.role !== 'admin') fail(`${email} belongs to a fund but is not its admin.`)
    fundId = membership.fund_id
    await db.from('fund_settings').update({ agent_api_enabled: true }).eq('fund_id', fundId)
    console.log('Using the fund you already run, with agent access on.')
  } else {
    if (!fundName) fail('Pass --fund "Your Fund Name" to create the fund.')
    const refusal = await fundCreationRefusal(admin, userId)
    if (refusal) fail(refusal)
    const created = await createFund(admin, { userId, email, fundName, ai: aiKey, agentApiEnabled: true })
    if (!created.ok) fail(created.error)
    fundId = created.fundId
    console.log(`Created "${fundName}" with you as its admin.`)
  }

  // 4. Products, through the same plan the setup_fund tool applies.
  const products = arg('products')
  if (products) {
    const plan = parseSetupPlan({ products: products.split(',').map(p => p.trim()).filter(Boolean) })
    if ('error' in plan) fail(plan.error)
    const result = await applySetupPlan(admin, { fundId, actorId: userId }, plan)
    console.log(`Products on: ${result.products?.on.join(', ')}`)
    for (const w of result.warnings) console.log(`Note: ${w}`)
  }

  // 5. How AI runs here. Only the no-key choice is recorded: a saved key is what makes a fund
  //    run on the server key, and an existing fund's key is changed in Settings, not here.
  if (aiChoice === 'assistant') {
    const { error } = await db.from('fund_settings').update({ ai_mode: 'assistant' }).eq('fund_id', fundId)
    if (error) console.log(error.code === '42703'
      ? 'Note: could not record the AI choice; the database needs the latest migrations (supabase db push).'
      : `Note: could not record the AI choice: ${error.message}`)
    else console.log('AI runs through your own assistant, with no server key.')
  }

  // 6. A key for the agent API and MCP, shown once.
  const origin = siteOrigin()
  if (!process.argv.includes('--no-key')) {
    const key = generateApiKey()
    const { error } = await db.from('fund_api_keys').insert({
      fund_id: fundId, user_id: userId, name: 'Bootstrap', key_prefix: key.prefix, key_hash: key.hash, scopes: 'read,write',
    })
    if (error) fail(`Could not create the API key: ${error.message}`)
    console.log(`\nAPI key (shown once, store it somewhere safe; revoke it in Settings → API and MCP):\n  ${key.token}\n`)
  }

  const { data: savedSettings } = await db.from('fund_settings').select('*').eq('fund_id', fundId).maybeSingle()
  if (!hasAnyAIKey(savedSettings)) printKeylessSummary(aiChoice === 'assistant')

  console.log(`MCP server:  ${origin}/api/mcp   (Claude and ChatGPT sign in with OAuth; scripts send the key as a Bearer token)`)
  console.log(`Agent API:   ${origin}/api/agent  (GET lists tools; POST {"tool": "setup_status", "input": {}})`)
  console.log('Next: run the setup prompt in DOCS.md ("Setting up a fund with Claude, ChatGPT or a script"), in Claude or as a script.')
}

function printKeylessSummary(chosen: boolean) {
  console.log(chosen ? '\nWith no server AI key:' : '\nNo server AI key is stored. Without one (pass --ai assistant to make it the plan):')
  console.log('  Works from your assistant over MCP:')
  for (const c of AI_CAPABILITIES.filter(c => c.keyless === 'assistant')) console.log(`    - ${c.label}`)
  console.log('  Needs a server key (add one in Settings → AI providers):')
  for (const c of AI_CAPABILITIES.filter(c => c.keyless === 'needs_key')) console.log(`    - ${c.label}: ${c.why}`)
  console.log('')
}

main().catch(e => fail(e instanceof Error ? e.message : String(e)))
