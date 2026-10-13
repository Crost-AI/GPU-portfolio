-- Quarterly investor capital account statements, as a compliance item.
--
-- Vehicle-scoped and quarterly, so each vehicle gets four occurrences a year on the compliance
-- calendar and in the ops-reminders digest. WHO gets the statements is fund data, not reference
-- data: it lives in compliance_fund_settings.notes on the vehicle's row (portfolio_group = the
-- vehicle name, no quarter), which the compliance page shows on every quarter's occurrence.

insert into compliance_items (id, category, name, short_name, description, frequency, deadline_description, deadline_month, deadline_day, rolling_days, applicability_text, applicability_question, filing_system, filing_portal_url, regulation_url, form_instructions_url, complexity, notes, alert, sort_order, scope) values
('lp-capital-statements', 'Fund Reporting', 'Investor Capital Account Statements', 'Capital Statements',
 'Quarterly capital account statement for each limited partner: the roll-forward of their capital for the quarter, year to date and since inception, and their commitment, contributions and unfunded commitment. Generate, review and send one per investor in each vehicle.',
 'Quarterly',
 '45 days after quarter end — February 14, May 15, August 14, November 14',
 null, null, null,
 'All funds that report capital account balances to limited partners.',
 'Does your fund send quarterly capital account statements to its limited partners?',
 'Internal', null, 'https://ilpa.org/reporting-template/', null, 'medium',
 'Statements are generated from Accounting → Capital accounts (or the lp_statement_pdf agent tool) after the quarter is closed and approved. Keep the vehicle''s distribution list in this item''s notes, including anyone who starts receiving statements in a later quarter.',
 null, 28, 'vehicle')
on conflict (id) do update set
  category = excluded.category,
  name = excluded.name,
  short_name = excluded.short_name,
  description = excluded.description,
  frequency = excluded.frequency,
  deadline_description = excluded.deadline_description,
  deadline_month = excluded.deadline_month,
  deadline_day = excluded.deadline_day,
  rolling_days = excluded.rolling_days,
  applicability_text = excluded.applicability_text,
  applicability_question = excluded.applicability_question,
  filing_system = excluded.filing_system,
  filing_portal_url = excluded.filing_portal_url,
  regulation_url = excluded.regulation_url,
  form_instructions_url = excluded.form_instructions_url,
  complexity = excluded.complexity,
  notes = excluded.notes,
  alert = excluded.alert,
  sort_order = excluded.sort_order,
  scope = excluded.scope,
  updated_at = now();
