---
name: capital-call-notice
description: >
  This skill should be used when the user asks the Portfolio connector to draft, check, revise or
  approve a capital call notice: "draft a capital call notice for Fund II", "call $2M for the Acme
  round and Q1 fees, due March 15", "what is each LP's share of this call", "what's missing from
  the notice", "does this due date respect the LPA notice period", "approve the call notice".
metadata:
  version: "1.0.0"
---

# Capital call notices

The fund's app drafts the notice itself. It computes each LP's share from the commitments it has
on record, checks every date against the LPA notice period recorded on the vehicle, and lists what
is missing. Your job is to collect the request, call the tool, and present what it returns.

## Draft one

1. Take from the user: the vehicle, the total call, what it is for with an amount per purpose
   (investments, management fees, fund expenses), the notice date, the due date and, if they
   say it, the LPA notice period. Pass only what they said.
2. Call `draft_capital_call_notice`. Put the user's own figures in `purposes`; never split a total
   into purposes yourself.
3. Show the per-LP table from `lines`: LP, commitment, share %, amount, remaining after the call.
4. Then list everything under `missing` and everything under `flags`, in the tool's words, under
   the headings "Missing information" and "Flags". A flag with a `date` inside the notice period
   says so; repeat the earliest due date the tool gives.

## What you never do

- Never invent or assume a date. A missing notice date or due date is listed, not set to today.
- Never write wire instructions. They come from the vehicle's settings; if the tool lists them as
  missing, say so.
- Never state fee terms (rate, base, period) the user did not give. The app holds no LPA fee terms.
- Never use a commitment or percentage the user typed in place of the one on record. If theirs
  differs from the table, point out the difference.

## Change, preview, approve

- To change a draft, call `revise_capital_call_notice` with only the fields that change.
- `capital_call_notice_pdf` gives a link to one LP's notice as it stands, marked DRAFT. Give it as a
  link; it works for an hour.
- A draft is invisible to LPs. `approve_capital_call_notice` issues the call. Only an admin can
  approve, and from chat the approval waits for them in the app; approving on the vehicle's Admin
  page also puts each LP's own notice in their portal. Ask for approval only when the draft is
  approvable. If it needs acknowledgement, read each warning to the user and set `acknowledge`
  only after they accept them.
- To record the LPA notice period once for the vehicle, an admin can use `set_call_notice_period`.
