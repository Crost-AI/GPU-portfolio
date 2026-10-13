-- demo-seed-oct-2026: the demo fund's data for the features in #92 and #94, applied once to the Hemrock Ventures
-- demo fund on portfolio.hemrock.com (fund e2dfd2bf…), after 20261013150000_proposed_capital_calls.sql.
-- `npm run demo:snapshot` and `npm run demo:record` then capture what the pages show.
--
-- What it adds:
--   * Company updates for Q2 and Q3 2026, each from an inbound email, with the KPI values they report.
--     GreenLeaf Bio and Lattis have not sent Q3, so the quarter status and the Q3 letter show a gap.
--   * The Q3 2026 data request to every company (due 15 Oct).
--   * Fund I LP letters: Q2 2026 final and shared with the Fund I investors, Q3 2026 a draft.
--   * Capital call #8's purposes, a 10-day notice period and wire instructions on Fund I and Fund II.
--   * A proposed Fund I call whose due date falls inside the notice period, so the check flags it.
--   * The reporting profile on Fund I and Fund II: venture, in-house, 45 and 90 days.
--
-- GENERATED once by a script from the demo fund's live ids. Every inserted row is tagged
-- (inbound_emails.raw_payload->>'demo_seed', company_updates.parser_version, metric_values.notes,
-- proposed_capital_calls.created_source = 'demo-seed-oct-2026'; the letters and the request by fixed id), and
-- demo-seed-oct-2026-remove.sql takes it out and puts the updated settings back to unset.
begin;

-- The Q3 2026 data request.
insert into email_requests (id, fund_id, subject, body_html, recipients, sent_by, quarter_label, status, sent_at, send_results, due_date, quarter, year) values ('57e6d20e-86e2-56f7-bd43-64c128370bef', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026 Portfolio Update Request', '<p>Hi team,</p><p>Please send your Q3 2026 update and metrics by October 15. We are preparing the quarterly LP letters.</p><p>Best,<br>Hemrock Ventures</p>', '[{"emails": ["sarah@novatech.io"], "companyName": "NovaTech"}, {"emails": ["priya@greenleafbio.com"], "companyName": "GreenLeaf Bio"}, {"emails": ["james@routewise.co", "lin@routewise.co"], "companyName": "RouteWise"}, {"emails": ["jamie@advantage.io"], "companyName": "AdVantage"}, {"emails": ["anna@verdant.earth"], "companyName": "Verdant"}, {"emails": ["kemi@tapfin.ng"], "companyName": "TapFin"}, {"emails": ["emily@benchline.com", "tom@benchline.com"], "companyName": "Benchline"}, {"emails": ["elena@lattis.dev"], "companyName": "Lattis"}]'::jsonb, 'e95bae2f-0a73-483c-9e9c-f64992e8054a', 'Q3 2026', 'sent', '2026-10-01T15:00:00Z', '{"sent": 8, "failed": 0, "details": []}'::jsonb, '2026-10-15', 3, 2026);

-- Company updates: one inbound email each, the update filed from it, and the KPI values it reported.
insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('327e8625-f246-544e-bcca-3c295aa4cadf', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'a67954cb-474b-404b-858b-49c240c22027', 'sarah@novatech.io', 'NovaTech Q2 2026 investor update', '2026-07-14T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "sarah@novatech.io", "Subject": "NovaTech Q2 2026 investor update", "FromFull": {"Name": "Sarah Chen", "Email": "sarah@novatech.io"}, "TextBody": "Hi all,\n\nQ2 was our strongest quarter yet. MRR reached $331K in June, up 12% on March, and net revenue retention rose to 122%. The Series B extension we closed in February is mostly in the bank: cash was $4.1M at the end of June against a monthly burn of $98K.\n\nHighlights\n- Signed our two largest enterprise contracts to date, both multi-year.\n- Shipped the churn-prediction module to every customer on the Growth plan.\n\nLowlights\n- Our VP Sales left in May. Sarah is covering the role while we hire.\n\nAsks: introductions to heads of customer success at mid-market SaaS companies.\n\nSarah", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 12, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('64e1304f-aad6-55f3-b4d1-148e763e6e83', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'a67954cb-474b-404b-858b-49c240c22027', 'email', 'reporting', '327e8625-f246-544e-bcca-3c295aa4cadf', 'Sarah Chen', 'sarah@novatech.io', 'NovaTech Q2 2026 investor update', '2026-07-14T16:30:00Z', 'Q2 2026', 2026, 2, 'Hi all,

Q2 was our strongest quarter yet. MRR reached $331K in June, up 12% on March, and net revenue retention rose to 122%. The Series B extension we closed in February is mostly in the bank: cash was $4.1M at the end of June against a monthly burn of $98K.

Highlights
- Signed our two largest enterprise contracts to date, both multi-year.
- Shipped the churn-prediction module to every customer on the Growth plan.

Lowlights
- Our VP Sales left in May. Sarah is covering the role while we hire.

Asks: introductions to heads of customer success at mid-market SaaS companies.

Sarah', 'Hi all,

Q2 was our strongest quarter yet. MRR reached $331K in June, up 12% on March, and net revenue retention rose to 122%. The Series B extension we closed in February is mostly in the bank: cash was $4.1M at the end of June against a monthly burn of $98K.

Highlights
- Signed our two largest enterprise contracts to date, both multi-year.
- Shipped the churn-prediction module to every customer on the Growth plan.

Lowlights
- Our VP Sales left in May. Sarah is covering the role while we hire.

Asks: introductions to heads of customer success at mid-market SaaS companies.

Sarah', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('38131239-e04c-50a0-bcfa-636d41652409', 'b5c80d5e-699a-44d9-b299-9a685efd6dd6', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Jan 2026', 2026, 1, 1, 270000, 'high', '327e8625-f246-544e-bcca-3c295aa4cadf', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('fc813ad9-d2ac-56ab-a12b-2c89bd0f9a96', 'b5c80d5e-699a-44d9-b299-9a685efd6dd6', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Feb 2026', 2026, 1, 2, 282000, 'high', '327e8625-f246-544e-bcca-3c295aa4cadf', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('f8643162-5f9a-5683-b33d-a66b14027ceb', 'b5c80d5e-699a-44d9-b299-9a685efd6dd6', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Mar 2026', 2026, 1, 3, 295000, 'high', '327e8625-f246-544e-bcca-3c295aa4cadf', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('c25c9f06-90b9-5bcf-b2c1-2ae1cf329793', 'b5c80d5e-699a-44d9-b299-9a685efd6dd6', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Apr 2026', 2026, 2, 4, 306000, 'high', '327e8625-f246-544e-bcca-3c295aa4cadf', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('6bc628c1-51a5-5a3f-854f-e8c2f1c077ef', 'b5c80d5e-699a-44d9-b299-9a685efd6dd6', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'May 2026', 2026, 2, 5, 318000, 'high', '327e8625-f246-544e-bcca-3c295aa4cadf', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('4b3f1b02-36e4-594a-a7e7-4dc3711a8c11', 'b5c80d5e-699a-44d9-b299-9a685efd6dd6', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Jun 2026', 2026, 2, 6, 331000, 'high', '327e8625-f246-544e-bcca-3c295aa4cadf', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('b73661ed-701b-514e-a804-cc020d334dbc', 'acd546b6-43da-410e-8ccb-76b6eaa7e1af', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 96000, 'high', '327e8625-f246-544e-bcca-3c295aa4cadf', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('27b90557-2ee8-558f-8e0f-4d6bbd6c91e3', 'acd546b6-43da-410e-8ccb-76b6eaa7e1af', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 98000, 'high', '327e8625-f246-544e-bcca-3c295aa4cadf', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('eef8f03f-23cb-5ef5-b0ae-8c8dd3d7939d', 'c78dbad1-2eb6-48b2-9b69-fc4ac1922bef', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 121, 'high', '327e8625-f246-544e-bcca-3c295aa4cadf', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('87d2a2b7-d7b9-5952-9ab4-2864c404e66d', 'c78dbad1-2eb6-48b2-9b69-fc4ac1922bef', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 122, 'high', '327e8625-f246-544e-bcca-3c295aa4cadf', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('7cfe2e44-375f-53b6-abc4-a5c3718533b8', '11a8a6a4-657f-42e2-9bfe-192adac70fa4', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 4400000, 'high', '327e8625-f246-544e-bcca-3c295aa4cadf', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('d9030404-8aec-5318-bdf9-f87f3bff0a33', '11a8a6a4-657f-42e2-9bfe-192adac70fa4', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 4100000, 'high', '327e8625-f246-544e-bcca-3c295aa4cadf', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('21445251-019b-5a20-9e59-f511ec520030', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'a67954cb-474b-404b-858b-49c240c22027', 'sarah@novatech.io', 'NovaTech Q3 2026 update', '2026-10-09T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "sarah@novatech.io", "Subject": "NovaTech Q3 2026 update", "FromFull": {"Name": "Sarah Chen", "Email": "sarah@novatech.io"}, "TextBody": "Hi all,\n\nMRR was $371K in September, up 12% on June. Net revenue retention is 124% and burn held at $101K a month, leaving $3.8M of cash at quarter end.\n\nWe hired a new VP Sales (starts November) and opened a small team in Austin. Pipeline for Q4 is the largest we have had, though two of the bigger deals have slipped to January.\n\nSarah", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 6, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('f15ab7f6-8ba8-5a4e-95c4-bfe7424993a2', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'a67954cb-474b-404b-858b-49c240c22027', 'email', 'reporting', '21445251-019b-5a20-9e59-f511ec520030', 'Sarah Chen', 'sarah@novatech.io', 'NovaTech Q3 2026 update', '2026-10-09T16:30:00Z', 'Q3 2026', 2026, 3, 'Hi all,

MRR was $371K in September, up 12% on June. Net revenue retention is 124% and burn held at $101K a month, leaving $3.8M of cash at quarter end.

We hired a new VP Sales (starts November) and opened a small team in Austin. Pipeline for Q4 is the largest we have had, though two of the bigger deals have slipped to January.

Sarah', 'Hi all,

MRR was $371K in September, up 12% on June. Net revenue retention is 124% and burn held at $101K a month, leaving $3.8M of cash at quarter end.

We hired a new VP Sales (starts November) and opened a small team in Austin. Pipeline for Q4 is the largest we have had, though two of the bigger deals have slipped to January.

Sarah', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('71879fcc-1e71-57b6-9074-9c8f4192b8ea', 'b5c80d5e-699a-44d9-b299-9a685efd6dd6', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Jul 2026', 2026, 3, 7, 342000, 'high', '21445251-019b-5a20-9e59-f511ec520030', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('7966f2fc-9232-590e-860c-d23d2089922f', 'b5c80d5e-699a-44d9-b299-9a685efd6dd6', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Aug 2026', 2026, 3, 8, 356000, 'high', '21445251-019b-5a20-9e59-f511ec520030', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('6dc9929d-50d5-5cb7-afd3-d7dbd479e7d4', 'b5c80d5e-699a-44d9-b299-9a685efd6dd6', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Sep 2026', 2026, 3, 9, 371000, 'high', '21445251-019b-5a20-9e59-f511ec520030', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('72235e51-2529-5d26-abf4-96c0b518cde2', 'acd546b6-43da-410e-8ccb-76b6eaa7e1af', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 101000, 'high', '21445251-019b-5a20-9e59-f511ec520030', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('095fd31d-9f38-5067-9114-ee2418de764f', 'c78dbad1-2eb6-48b2-9b69-fc4ac1922bef', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 124, 'high', '21445251-019b-5a20-9e59-f511ec520030', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('96b3cdfd-45c9-5746-9f4a-1b02c7cc0658', '11a8a6a4-657f-42e2-9bfe-192adac70fa4', 'a67954cb-474b-404b-858b-49c240c22027', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 3800000, 'high', '21445251-019b-5a20-9e59-f511ec520030', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('a6a0cd45-77ae-5c7b-8fce-6a2bc82b6966', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'jamie@advantage.io', 'AdVantage — Q2 2026 update', '2026-07-16T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "jamie@advantage.io", "Subject": "AdVantage — Q2 2026 update", "FromFull": {"Name": "Jamie Ortiz", "Email": "jamie@advantage.io"}, "TextBody": "Team,\n\nMRR reached $390K in June, up 8% on March. Logo churn improved to 2.6% for the quarter after we moved our smallest accounts to annual contracts.\n\nThe programmatic TV beta is live with four retailers. We expect to price it in Q4.\n\nCash is comfortable; we are not raising this year.\n\nJamie", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 7, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('94c91130-4595-55ba-a90d-854869de8f10', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'email', 'reporting', 'a6a0cd45-77ae-5c7b-8fce-6a2bc82b6966', 'Jamie Ortiz', 'jamie@advantage.io', 'AdVantage — Q2 2026 update', '2026-07-16T16:30:00Z', 'Q2 2026', 2026, 2, 'Team,

MRR reached $390K in June, up 8% on March. Logo churn improved to 2.6% for the quarter after we moved our smallest accounts to annual contracts.

The programmatic TV beta is live with four retailers. We expect to price it in Q4.

Cash is comfortable; we are not raising this year.

Jamie', 'Team,

MRR reached $390K in June, up 8% on March. Logo churn improved to 2.6% for the quarter after we moved our smallest accounts to annual contracts.

The programmatic TV beta is live with four retailers. We expect to price it in Q4.

Cash is comfortable; we are not raising this year.

Jamie', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('b2dfbd5b-7254-5509-b46d-4139d09fe643', '70de331d-9a0f-4056-834e-06cb613b7409', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Feb 2026', 2026, 1, 2, 355000, 'high', 'a6a0cd45-77ae-5c7b-8fce-6a2bc82b6966', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('4a691102-3681-5c35-92f0-c7f6244247e1', '70de331d-9a0f-4056-834e-06cb613b7409', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Mar 2026', 2026, 1, 3, 362000, 'high', 'a6a0cd45-77ae-5c7b-8fce-6a2bc82b6966', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('3c03269d-02e4-536a-8f75-ae5d84526382', '70de331d-9a0f-4056-834e-06cb613b7409', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Apr 2026', 2026, 2, 4, 370000, 'high', 'a6a0cd45-77ae-5c7b-8fce-6a2bc82b6966', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('f3bdcb74-978c-5bb8-b98d-ac38b3196860', '70de331d-9a0f-4056-834e-06cb613b7409', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'May 2026', 2026, 2, 5, 381000, 'high', 'a6a0cd45-77ae-5c7b-8fce-6a2bc82b6966', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('8ec257a1-627d-5580-b05d-50cac30c8851', '70de331d-9a0f-4056-834e-06cb613b7409', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Jun 2026', 2026, 2, 6, 390000, 'high', 'a6a0cd45-77ae-5c7b-8fce-6a2bc82b6966', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('1f0e7401-a9b8-5234-8203-ab2a4408e20a', '01ccbf1a-b970-41d6-91a2-50525cba6745', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 2.9, 'high', 'a6a0cd45-77ae-5c7b-8fce-6a2bc82b6966', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('edff4dc5-4e98-506e-bdb5-66895aa7beb5', '01ccbf1a-b970-41d6-91a2-50525cba6745', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 2.6, 'high', 'a6a0cd45-77ae-5c7b-8fce-6a2bc82b6966', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('412f007f-3588-5728-8d02-a5d1e9991f6c', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'jamie@advantage.io', 'AdVantage — Q3 2026 update', '2026-10-10T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "jamie@advantage.io", "Subject": "AdVantage — Q3 2026 update", "FromFull": {"Name": "Jamie Ortiz", "Email": "jamie@advantage.io"}, "TextBody": "Team,\n\nMRR closed September at $421K, up 8% on June, and churn was 2.5%. Programmatic TV now has nine paying retailers.\n\nOne miss: the DSP partnership we flagged last quarter did not close; they chose to build in-house.\n\nJamie", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 4, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('d5428a0f-96f8-51b2-a1b7-88173e227b2e', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'email', 'reporting', '412f007f-3588-5728-8d02-a5d1e9991f6c', 'Jamie Ortiz', 'jamie@advantage.io', 'AdVantage — Q3 2026 update', '2026-10-10T16:30:00Z', 'Q3 2026', 2026, 3, 'Team,

MRR closed September at $421K, up 8% on June, and churn was 2.5%. Programmatic TV now has nine paying retailers.

One miss: the DSP partnership we flagged last quarter did not close; they chose to build in-house.

Jamie', 'Team,

MRR closed September at $421K, up 8% on June, and churn was 2.5%. Programmatic TV now has nine paying retailers.

One miss: the DSP partnership we flagged last quarter did not close; they chose to build in-house.

Jamie', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('4f2c1a56-d8d4-5e0f-96b3-f3c2bb811ff9', '70de331d-9a0f-4056-834e-06cb613b7409', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Jul 2026', 2026, 3, 7, 402000, 'high', '412f007f-3588-5728-8d02-a5d1e9991f6c', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('27dfd858-e21c-5983-9cab-a3cbd9ed2be8', '70de331d-9a0f-4056-834e-06cb613b7409', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Aug 2026', 2026, 3, 8, 409000, 'high', '412f007f-3588-5728-8d02-a5d1e9991f6c', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('d04e3e16-ad47-5f41-b845-082fbff73cc8', '70de331d-9a0f-4056-834e-06cb613b7409', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Sep 2026', 2026, 3, 9, 421000, 'high', '412f007f-3588-5728-8d02-a5d1e9991f6c', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('5c411bb8-d82f-5779-8f85-e5461f3fcf5e', '01ccbf1a-b970-41d6-91a2-50525cba6745', 'd08a27bc-39e4-4fb1-a624-7a286d83e929', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 2.5, 'high', '412f007f-3588-5728-8d02-a5d1e9991f6c', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('3d2e724e-4360-50e7-be92-c68788582a0a', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'b4870bad-ddd4-42d1-a300-7111899cf154', 'james@routewise.co', 'RouteWise Q2 2026 Quarterly Report', '2026-07-11T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "james@routewise.co", "Subject": "RouteWise Q2 2026 Quarterly Report", "FromFull": {"Name": "James Okafor", "Email": "james@routewise.co"}, "TextBody": "Hi Hemrock team,\n\nARR reached $6.6M at the end of June, up from $6.1M in March. We added 7 customers (81 total) and gross margin improved to 69%.\n\nThe London office opened in April and has signed its first two UK customers. We are planning a Series C process for early 2027 and would welcome the fund''s view on a pro-rata follow-on.\n\nJames", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 3, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('8e620895-f90f-5049-8683-9718c15192d7', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'b4870bad-ddd4-42d1-a300-7111899cf154', 'email', 'reporting', '3d2e724e-4360-50e7-be92-c68788582a0a', 'James Okafor', 'james@routewise.co', 'RouteWise Q2 2026 Quarterly Report', '2026-07-11T16:30:00Z', 'Q2 2026', 2026, 2, 'Hi Hemrock team,

ARR reached $6.6M at the end of June, up from $6.1M in March. We added 7 customers (81 total) and gross margin improved to 69%.

The London office opened in April and has signed its first two UK customers. We are planning a Series C process for early 2027 and would welcome the fund''s view on a pro-rata follow-on.

James', 'Hi Hemrock team,

ARR reached $6.6M at the end of June, up from $6.1M in March. We added 7 customers (81 total) and gross margin improved to 69%.

The London office opened in April and has signed its first two UK customers. We are planning a Series C process for early 2027 and would welcome the fund''s view on a pro-rata follow-on.

James', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('b9730880-42f2-58dc-a6d5-62ae66059b25', 'e6e9c340-1975-4a89-8905-891e6a6dbca1', 'b4870bad-ddd4-42d1-a300-7111899cf154', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 6600000, 'high', '3d2e724e-4360-50e7-be92-c68788582a0a', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('19556c66-295f-5ca2-8e75-55915b060328', '0c3488a9-cf46-4b72-8701-7b8e931d3e9a', 'b4870bad-ddd4-42d1-a300-7111899cf154', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 69, 'high', '3d2e724e-4360-50e7-be92-c68788582a0a', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('c4ebcff5-c2e8-5a9a-8c20-87abde79edcd', 'd70800bd-c2cc-4882-a455-fa8c635c3b38', 'b4870bad-ddd4-42d1-a300-7111899cf154', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 81, 'high', '3d2e724e-4360-50e7-be92-c68788582a0a', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('10081b33-d60d-5ced-8d64-bb3720e58435', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'b4870bad-ddd4-42d1-a300-7111899cf154', 'james@routewise.co', 'RouteWise Q3 2026 Quarterly Report', '2026-10-08T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "james@routewise.co", "Subject": "RouteWise Q3 2026 Quarterly Report", "FromFull": {"Name": "James Okafor", "Email": "james@routewise.co"}, "TextBody": "Hi Hemrock team,\n\nARR was $7.2M at the end of September with 88 customers and 70% gross margin. Europe is now 9% of new ARR.\n\nWe have term sheet interest for a Series C at a higher valuation and expect to close in Q4. We would like Hemrock''s follow-on decision by the end of October.\n\nJames", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 3, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('a4b1e9b9-e7e0-5796-823a-6fe3080484e2', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'b4870bad-ddd4-42d1-a300-7111899cf154', 'email', 'reporting', '10081b33-d60d-5ced-8d64-bb3720e58435', 'James Okafor', 'james@routewise.co', 'RouteWise Q3 2026 Quarterly Report', '2026-10-08T16:30:00Z', 'Q3 2026', 2026, 3, 'Hi Hemrock team,

ARR was $7.2M at the end of September with 88 customers and 70% gross margin. Europe is now 9% of new ARR.

We have term sheet interest for a Series C at a higher valuation and expect to close in Q4. We would like Hemrock''s follow-on decision by the end of October.

James', 'Hi Hemrock team,

ARR was $7.2M at the end of September with 88 customers and 70% gross margin. Europe is now 9% of new ARR.

We have term sheet interest for a Series C at a higher valuation and expect to close in Q4. We would like Hemrock''s follow-on decision by the end of October.

James', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('de0553a5-bdd4-582f-a712-703c42ca6459', 'e6e9c340-1975-4a89-8905-891e6a6dbca1', 'b4870bad-ddd4-42d1-a300-7111899cf154', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 7200000, 'high', '10081b33-d60d-5ced-8d64-bb3720e58435', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('d7262224-b0db-5d44-a480-c0a28e5a093a', '0c3488a9-cf46-4b72-8701-7b8e931d3e9a', 'b4870bad-ddd4-42d1-a300-7111899cf154', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 70, 'high', '10081b33-d60d-5ced-8d64-bb3720e58435', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('3cd779d0-0931-5809-a46d-343045e9ea77', 'd70800bd-c2cc-4882-a455-fa8c635c3b38', 'b4870bad-ddd4-42d1-a300-7111899cf154', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 88, 'high', '10081b33-d60d-5ced-8d64-bb3720e58435', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('b1820126-b5ac-59e1-963d-24949dfa0db8', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'd4fef540-f26b-426f-9aef-96144a6579ce', 'priya@greenleafbio.com', 'GreenLeaf Bio Q2 update', '2026-07-21T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "priya@greenleafbio.com", "Subject": "GreenLeaf Bio Q2 update", "FromFull": {"Name": "Priya Raman", "Email": "priya@greenleafbio.com"}, "TextBody": "Dear investors,\n\nPlainly: the EPA has asked for an additional field season of data, so approval moves from Q2 2026 to the second half of 2027. Pilot revenue is unchanged.\n\nCash was $950K at the end of June, about five months of runway. We are raising a bridge and have $600K of soft commitments; we would welcome the fund''s participation.\n\nHeadcount is 15.\n\nPriya", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 4, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('70e35de2-f918-5b6b-84a7-8a5121686c25', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'd4fef540-f26b-426f-9aef-96144a6579ce', 'email', 'reporting', 'b1820126-b5ac-59e1-963d-24949dfa0db8', 'Priya Raman', 'priya@greenleafbio.com', 'GreenLeaf Bio Q2 update', '2026-07-21T16:30:00Z', 'Q2 2026', 2026, 2, 'Dear investors,

Plainly: the EPA has asked for an additional field season of data, so approval moves from Q2 2026 to the second half of 2027. Pilot revenue is unchanged.

Cash was $950K at the end of June, about five months of runway. We are raising a bridge and have $600K of soft commitments; we would welcome the fund''s participation.

Headcount is 15.

Priya', 'Dear investors,

Plainly: the EPA has asked for an additional field season of data, so approval moves from Q2 2026 to the second half of 2027. Pilot revenue is unchanged.

Cash was $950K at the end of June, about five months of runway. We are raising a bridge and have $600K of soft commitments; we would welcome the fund''s participation.

Headcount is 15.

Priya', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('83721939-8fe4-5115-80b0-3fe74f78ff6b', '9b9b877d-70dd-4a43-a213-3d2c6c169a68', 'd4fef540-f26b-426f-9aef-96144a6579ce', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 1200000, 'high', 'b1820126-b5ac-59e1-963d-24949dfa0db8', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('b298538e-f43f-54ec-9cfa-5f24515953cf', '9b9b877d-70dd-4a43-a213-3d2c6c169a68', 'd4fef540-f26b-426f-9aef-96144a6579ce', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 950000, 'high', 'b1820126-b5ac-59e1-963d-24949dfa0db8', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('b566731b-14f4-50ec-a1c9-5148c94de458', 'cbc581d4-295c-4b83-867e-bdc62e45f4ff', 'd4fef540-f26b-426f-9aef-96144a6579ce', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 14, 'high', 'b1820126-b5ac-59e1-963d-24949dfa0db8', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('0bdb2a5d-bac3-5883-b253-f0b10a4f218d', 'cbc581d4-295c-4b83-867e-bdc62e45f4ff', 'd4fef540-f26b-426f-9aef-96144a6579ce', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 15, 'high', 'b1820126-b5ac-59e1-963d-24949dfa0db8', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('d66bbc56-cb06-5d70-be22-0325e2c9b300', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'd1263d61-e648-4906-b991-f831fb74a186', 'emily@benchline.com', 'Benchline Q2 2026', '2026-07-15T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "emily@benchline.com", "Subject": "Benchline Q2 2026", "FromFull": {"Name": "Emily Shaw", "Email": "emily@benchline.com"}, "TextBody": "Hello,\n\nARR grew to $11.6M (Q1: $10.8M). Net dollar retention eased to 124% as two large customers renewed flat. Headcount is 71 and cash $12.0M.\n\nEmily and Tom", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 7, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('3860fc9d-6e5d-585c-a7f4-bafd2830128d', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'd1263d61-e648-4906-b991-f831fb74a186', 'email', 'reporting', 'd66bbc56-cb06-5d70-be22-0325e2c9b300', 'Emily Shaw', 'emily@benchline.com', 'Benchline Q2 2026', '2026-07-15T16:30:00Z', 'Q2 2026', 2026, 2, 'Hello,

ARR grew to $11.6M (Q1: $10.8M). Net dollar retention eased to 124% as two large customers renewed flat. Headcount is 71 and cash $12.0M.

Emily and Tom', 'Hello,

ARR grew to $11.6M (Q1: $10.8M). Net dollar retention eased to 124% as two large customers renewed flat. Headcount is 71 and cash $12.0M.

Emily and Tom', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('b51d8cae-a96e-54cf-a4da-7e4f547b3996', 'eef2323e-3374-4a17-9017-0df8dc10f898', 'd1263d61-e648-4906-b991-f831fb74a186', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 11600000, 'high', 'd66bbc56-cb06-5d70-be22-0325e2c9b300', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('938de603-44db-58e9-bd80-fde2a1275578', '7202c8ed-060b-439e-8f11-53b46a1b7de3', 'd1263d61-e648-4906-b991-f831fb74a186', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 126, 'high', 'd66bbc56-cb06-5d70-be22-0325e2c9b300', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('cbc19539-caf7-5ab8-9d62-9d224097a4bb', '7202c8ed-060b-439e-8f11-53b46a1b7de3', 'd1263d61-e648-4906-b991-f831fb74a186', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 124, 'high', 'd66bbc56-cb06-5d70-be22-0325e2c9b300', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('4babcf8a-7b01-5163-bb77-7638c1369d65', '21f641a6-23e2-42be-af21-744899d210f8', 'd1263d61-e648-4906-b991-f831fb74a186', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 66, 'high', 'd66bbc56-cb06-5d70-be22-0325e2c9b300', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('f725a06d-e288-51a3-b108-1e7fd5847a67', '21f641a6-23e2-42be-af21-744899d210f8', 'd1263d61-e648-4906-b991-f831fb74a186', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 71, 'high', 'd66bbc56-cb06-5d70-be22-0325e2c9b300', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('b64837f0-77e0-5a4b-9e99-8e7df46b512d', 'd36210a6-ca19-41dd-80d9-86d6493185c9', 'd1263d61-e648-4906-b991-f831fb74a186', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 13100000, 'high', 'd66bbc56-cb06-5d70-be22-0325e2c9b300', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('3697f342-933a-5ae2-b57b-cd971b29cb6c', 'd36210a6-ca19-41dd-80d9-86d6493185c9', 'd1263d61-e648-4906-b991-f831fb74a186', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 12000000, 'high', 'd66bbc56-cb06-5d70-be22-0325e2c9b300', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('97126db6-7bad-53cd-a263-a99cf125f4bb', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'd1263d61-e648-4906-b991-f831fb74a186', 'emily@benchline.com', 'Benchline Q3 2026', '2026-10-07T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "emily@benchline.com", "Subject": "Benchline Q3 2026", "FromFull": {"Name": "Emily Shaw", "Email": "emily@benchline.com"}, "TextBody": "Hello,\n\nARR is $12.3M, NDR 123%, headcount 74 and cash $11.2M. We are slowing hiring for the rest of the year to keep runway above 30 months.\n\nEmily and Tom", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 4, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('9526c353-483b-5d92-bde5-a1b86a10bd32', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'd1263d61-e648-4906-b991-f831fb74a186', 'email', 'reporting', '97126db6-7bad-53cd-a263-a99cf125f4bb', 'Emily Shaw', 'emily@benchline.com', 'Benchline Q3 2026', '2026-10-07T16:30:00Z', 'Q3 2026', 2026, 3, 'Hello,

ARR is $12.3M, NDR 123%, headcount 74 and cash $11.2M. We are slowing hiring for the rest of the year to keep runway above 30 months.

Emily and Tom', 'Hello,

ARR is $12.3M, NDR 123%, headcount 74 and cash $11.2M. We are slowing hiring for the rest of the year to keep runway above 30 months.

Emily and Tom', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('ae9b3caa-c0a0-5034-9900-2b5312f912be', 'eef2323e-3374-4a17-9017-0df8dc10f898', 'd1263d61-e648-4906-b991-f831fb74a186', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 12300000, 'high', '97126db6-7bad-53cd-a263-a99cf125f4bb', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('7db0a441-b5c1-5cd0-8fe3-01f77fb2c8ec', '7202c8ed-060b-439e-8f11-53b46a1b7de3', 'd1263d61-e648-4906-b991-f831fb74a186', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 123, 'high', '97126db6-7bad-53cd-a263-a99cf125f4bb', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('07051a14-005b-5580-9b38-f236737cb58a', '21f641a6-23e2-42be-af21-744899d210f8', 'd1263d61-e648-4906-b991-f831fb74a186', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 74, 'high', '97126db6-7bad-53cd-a263-a99cf125f4bb', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('fa399d7c-e4ad-59b4-b0a3-dc0624290b8d', 'd36210a6-ca19-41dd-80d9-86d6493185c9', 'd1263d61-e648-4906-b991-f831fb74a186', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 11200000, 'high', '97126db6-7bad-53cd-a263-a99cf125f4bb', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('05c4eed5-f90c-5e80-a085-1eb8427d5011', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '2231479f-1bf3-4646-9173-abc5d31fd515', 'kemi@tapfin.ng', 'TapFin update — Q2 2026', '2026-07-17T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "kemi@tapfin.ng", "Subject": "TapFin update — Q2 2026", "FromFull": {"Name": "Kemi Adeyemi", "Email": "kemi@tapfin.ng"}, "TextBody": "Hi all,\n\nGMV was $23.5M in June and revenue $352K at a steady 1.5% take rate. We launched in Ghana in May.\n\nCash was $2.6M at quarter end. We plan to raise in Q1 2027.\n\nKemi", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 14, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('6943f9d9-dd3c-5578-8f8d-ac11d7fc53ff', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '2231479f-1bf3-4646-9173-abc5d31fd515', 'email', 'reporting', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'Kemi Adeyemi', 'kemi@tapfin.ng', 'TapFin update — Q2 2026', '2026-07-17T16:30:00Z', 'Q2 2026', 2026, 2, 'Hi all,

GMV was $23.5M in June and revenue $352K at a steady 1.5% take rate. We launched in Ghana in May.

Cash was $2.6M at quarter end. We plan to raise in Q1 2027.

Kemi', 'Hi all,

GMV was $23.5M in June and revenue $352K at a steady 1.5% take rate. We launched in Ghana in May.

Cash was $2.6M at quarter end. We plan to raise in Q1 2027.

Kemi', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('ea35a52a-40df-50e2-98db-ca96afdd8d64', '63cba462-17f1-456e-8fd6-ca18bb3b0a4a', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Feb 2026', 2026, 1, 2, 18900000, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('0212407e-594c-5011-9cc3-534504c07f39', '63cba462-17f1-456e-8fd6-ca18bb3b0a4a', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Mar 2026', 2026, 1, 3, 20100000, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('7166e733-bc1b-562c-a4db-b4e25e94b22b', '63cba462-17f1-456e-8fd6-ca18bb3b0a4a', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Apr 2026', 2026, 2, 4, 21400000, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('43b8d2c0-0b6b-5f37-9a4b-896dd48f0e08', '63cba462-17f1-456e-8fd6-ca18bb3b0a4a', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'May 2026', 2026, 2, 5, 22000000, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('df63eeb9-69d1-5643-9dbb-9474fbf7785f', '63cba462-17f1-456e-8fd6-ca18bb3b0a4a', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Jun 2026', 2026, 2, 6, 23500000, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('45266d4a-2cc2-5e25-a55c-63b9bc298c5c', '65345f9f-15e7-4199-8d45-ce44af7bf54f', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Feb 2026', 2026, 1, 2, 283500, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('1afae1f8-4437-5ffd-98c9-3de004525b2a', '65345f9f-15e7-4199-8d45-ce44af7bf54f', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Mar 2026', 2026, 1, 3, 301500, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('9e50b0e7-063e-52b3-a962-76c0592c1580', '65345f9f-15e7-4199-8d45-ce44af7bf54f', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Apr 2026', 2026, 2, 4, 321000, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('49bd6f95-f5c8-53e9-a33a-26baf060a21a', '65345f9f-15e7-4199-8d45-ce44af7bf54f', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'May 2026', 2026, 2, 5, 330000, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('03d6fa6c-db86-53e4-9a0d-5d2fbace99da', '65345f9f-15e7-4199-8d45-ce44af7bf54f', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Jun 2026', 2026, 2, 6, 352500, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('c92fe823-9a80-5f18-b250-f9506ff92fc5', 'cdf766ee-c094-42d2-9061-67f9356fb68c', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 1.5, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('1bf0f860-b4c4-5ccf-a357-c5d1a71f8ee4', 'cdf766ee-c094-42d2-9061-67f9356fb68c', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 1.5, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('bcbdf8e3-033c-560d-a421-1ad9e46beef9', '5cb4ee19-b309-4c58-a811-f6028597850b', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 2900000, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('a1c6b3f9-1d45-5891-93a5-a47b0c04138a', '5cb4ee19-b309-4c58-a811-f6028597850b', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 2600000, 'high', '05c4eed5-f90c-5e80-a085-1eb8427d5011', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('61909565-edfd-5679-a1b9-ce653bc02a6d', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '2231479f-1bf3-4646-9173-abc5d31fd515', 'kemi@tapfin.ng', 'TapFin update — Q3 2026', '2026-10-12T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "kemi@tapfin.ng", "Subject": "TapFin update — Q3 2026", "FromFull": {"Name": "Kemi Adeyemi", "Email": "kemi@tapfin.ng"}, "TextBody": "Hi all,\n\nSeptember GMV reached $26.9M and revenue $403.5K. Ghana is growing faster than Nigeria did in its first quarter.\n\nCash is $2.2M, which is tighter than we planned because of FX losses on naira balances. We have started the fundraise early.\n\nKemi", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 8, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('8783e52b-cf30-5c13-9d73-162683d9ed0f', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '2231479f-1bf3-4646-9173-abc5d31fd515', 'email', 'reporting', '61909565-edfd-5679-a1b9-ce653bc02a6d', 'Kemi Adeyemi', 'kemi@tapfin.ng', 'TapFin update — Q3 2026', '2026-10-12T16:30:00Z', 'Q3 2026', 2026, 3, 'Hi all,

September GMV reached $26.9M and revenue $403.5K. Ghana is growing faster than Nigeria did in its first quarter.

Cash is $2.2M, which is tighter than we planned because of FX losses on naira balances. We have started the fundraise early.

Kemi', 'Hi all,

September GMV reached $26.9M and revenue $403.5K. Ghana is growing faster than Nigeria did in its first quarter.

Cash is $2.2M, which is tighter than we planned because of FX losses on naira balances. We have started the fundraise early.

Kemi', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('0992e450-2db5-53f6-838b-4d43b040b5c5', '63cba462-17f1-456e-8fd6-ca18bb3b0a4a', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Jul 2026', 2026, 3, 7, 24800000, 'high', '61909565-edfd-5679-a1b9-ce653bc02a6d', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('051bcddd-c92a-5ef0-b11e-6d8d83618d80', '63cba462-17f1-456e-8fd6-ca18bb3b0a4a', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Aug 2026', 2026, 3, 8, 25300000, 'high', '61909565-edfd-5679-a1b9-ce653bc02a6d', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('b2f274e2-e99b-518b-8bb9-d8e6058350bb', '63cba462-17f1-456e-8fd6-ca18bb3b0a4a', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Sep 2026', 2026, 3, 9, 26900000, 'high', '61909565-edfd-5679-a1b9-ce653bc02a6d', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('08d7d6d0-e9f0-5f04-ad5b-36df14427c5e', '65345f9f-15e7-4199-8d45-ce44af7bf54f', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Jul 2026', 2026, 3, 7, 372000, 'high', '61909565-edfd-5679-a1b9-ce653bc02a6d', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('8337bdaf-fd63-5388-80e9-b04f8949efad', '65345f9f-15e7-4199-8d45-ce44af7bf54f', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Aug 2026', 2026, 3, 8, 379500, 'high', '61909565-edfd-5679-a1b9-ce653bc02a6d', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('98f509a1-92fd-5e97-8583-03a5efa290ab', '65345f9f-15e7-4199-8d45-ce44af7bf54f', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Sep 2026', 2026, 3, 9, 403500, 'high', '61909565-edfd-5679-a1b9-ce653bc02a6d', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('360fa280-2700-5250-a767-c2ceb1462241', 'cdf766ee-c094-42d2-9061-67f9356fb68c', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 1.5, 'high', '61909565-edfd-5679-a1b9-ce653bc02a6d', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('52141365-3435-5f38-968a-1e0a411dcb60', '5cb4ee19-b309-4c58-a811-f6028597850b', '2231479f-1bf3-4646-9173-abc5d31fd515', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 2200000, 'high', '61909565-edfd-5679-a1b9-ce653bc02a6d', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('634c2d8e-6230-5f2a-b60d-c32a8cb86bac', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '8b396e22-1612-4737-8d09-5dbf593bb08f', 'elena@lattis.dev', 'Lattis Q2', '2026-07-18T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "elena@lattis.dev", "Subject": "Lattis Q2", "FromFull": {"Name": "Elena Petrova", "Email": "elena@lattis.dev"}, "TextBody": "Hi,\n\nWe closed a $1.5M seed extension in May, so cash was $1.6M at the end of June. Burn is $52K a month. Design partners: 6, of which 2 have converted to paid.\n\nElena", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 4, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('2f2d6cdd-3a0f-598f-9c44-51bb9c843fb7', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '8b396e22-1612-4737-8d09-5dbf593bb08f', 'email', 'reporting', '634c2d8e-6230-5f2a-b60d-c32a8cb86bac', 'Elena Petrova', 'elena@lattis.dev', 'Lattis Q2', '2026-07-18T16:30:00Z', 'Q2 2026', 2026, 2, 'Hi,

We closed a $1.5M seed extension in May, so cash was $1.6M at the end of June. Burn is $52K a month. Design partners: 6, of which 2 have converted to paid.

Elena', 'Hi,

We closed a $1.5M seed extension in May, so cash was $1.6M at the end of June. Burn is $52K a month. Design partners: 6, of which 2 have converted to paid.

Elena', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('416795a4-3c4e-5c76-b926-8c112eb42ba1', 'd5f9be47-dac2-407f-b1b3-1e1ae0da9c3e', '8b396e22-1612-4737-8d09-5dbf593bb08f', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 410000, 'high', '634c2d8e-6230-5f2a-b60d-c32a8cb86bac', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('e5cf97ac-4efd-560a-8d5d-29b020e571ba', 'd5f9be47-dac2-407f-b1b3-1e1ae0da9c3e', '8b396e22-1612-4737-8d09-5dbf593bb08f', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 1600000, 'high', '634c2d8e-6230-5f2a-b60d-c32a8cb86bac', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('1cb56307-5f06-5d8a-abc5-461507c11fe0', '4991f311-515d-4573-936f-c630fa4baecd', '8b396e22-1612-4737-8d09-5dbf593bb08f', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 50000, 'high', '634c2d8e-6230-5f2a-b60d-c32a8cb86bac', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('918d6cbc-26b5-5827-885d-95c1504603c6', '4991f311-515d-4573-936f-c630fa4baecd', '8b396e22-1612-4737-8d09-5dbf593bb08f', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 52000, 'high', '634c2d8e-6230-5f2a-b60d-c32a8cb86bac', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('944c3b08-6569-58ce-8cda-77b49746091c', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '35dea40d-dd6f-4916-b566-deb40872d579', 'anna@verdant.earth', 'Verdant Q2 2026 report', '2026-07-22T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "anna@verdant.earth", "Subject": "Verdant Q2 2026 report", "FromFull": {"Name": "Anna Lindqvist", "Email": "anna@verdant.earth"}, "TextBody": "Hello,\n\nWe received a $250K state climate grant in June. Cash was $700K at quarter end with burn at $88K a month, which is too little runway; we are raising now.\n\nAnna", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 5, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('1b711053-a413-56d6-9606-f7f01cc54728', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '35dea40d-dd6f-4916-b566-deb40872d579', 'email', 'reporting', '944c3b08-6569-58ce-8cda-77b49746091c', 'Anna Lindqvist', 'anna@verdant.earth', 'Verdant Q2 2026 report', '2026-07-22T16:30:00Z', 'Q2 2026', 2026, 2, 'Hello,

We received a $250K state climate grant in June. Cash was $700K at quarter end with burn at $88K a month, which is too little runway; we are raising now.

Anna', 'Hello,

We received a $250K state climate grant in June. Cash was $700K at quarter end with burn at $88K a month, which is too little runway; we are raising now.

Anna', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('4ddd4eb2-3cb3-52fd-a944-27963f66be9a', '8596acff-4ef3-4c97-97f7-2424d73d5ec7', '35dea40d-dd6f-4916-b566-deb40872d579', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 900000, 'high', '944c3b08-6569-58ce-8cda-77b49746091c', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('3b933d1c-baae-51e3-97bc-1b461092db92', '8596acff-4ef3-4c97-97f7-2424d73d5ec7', '35dea40d-dd6f-4916-b566-deb40872d579', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 700000, 'high', '944c3b08-6569-58ce-8cda-77b49746091c', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('8c003277-7276-55e6-9031-b82b0531c96e', '6aca3122-f86b-4374-b3b8-7f9c80daf173', '35dea40d-dd6f-4916-b566-deb40872d579', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q1 2026', 2026, 1, null, 86000, 'high', '944c3b08-6569-58ce-8cda-77b49746091c', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('c4aa7394-145c-580e-9a73-f8512e68c9fb', '6aca3122-f86b-4374-b3b8-7f9c80daf173', '35dea40d-dd6f-4916-b566-deb40872d579', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 88000, 'high', '944c3b08-6569-58ce-8cda-77b49746091c', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('07600258-7198-5cc8-8b0a-f6f3dc0a50a1', '78d59428-5128-4861-8e2f-f9e9d1aabc7b', '35dea40d-dd6f-4916-b566-deb40872d579', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q2 2026', 2026, 2, null, 250000, 'high', '944c3b08-6569-58ce-8cda-77b49746091c', 'demo-seed-oct-2026', false);

insert into inbound_emails (id, fund_id, company_id, from_address, subject, received_at, raw_payload, processing_status, metrics_extracted, attachments_count, email_type, routed_to, routing_label, routing_confidence) values ('e06d89ba-edd7-5083-8e6c-2369b9d0eb5d', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '35dea40d-dd6f-4916-b566-deb40872d579', 'anna@verdant.earth', 'Verdant Q3 2026 report', '2026-10-13T16:30:00Z', '{"To": "reports@hemrock-demo.com", "From": "anna@verdant.earth", "Subject": "Verdant Q3 2026 report", "FromFull": {"Name": "Anna Lindqvist", "Email": "anna@verdant.earth"}, "TextBody": "Hello,\n\nA second grant of $400K arrived in August and burn came down to $84K. Cash was $1.0M at the end of September. The equity round is still open.\n\nAnna", "demo_seed": "demo-seed-oct-2026"}'::jsonb, 'success', 3, 0, 'metrics', 'reporting', 'reporting', 0.97);
insert into company_updates (id, fund_id, company_id, source, source_route, source_email_id, sender_name, sender_email, subject, received_at, period_label, period_year, period_quarter, body_original, body_current, body_status, body_cleaning_status, period_source, extraction_status, parser_version) values ('918362d8-4f6c-59da-aef4-825b5ea74af0', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '35dea40d-dd6f-4916-b566-deb40872d579', 'email', 'reporting', 'e06d89ba-edd7-5083-8e6c-2369b9d0eb5d', 'Anna Lindqvist', 'anna@verdant.earth', 'Verdant Q3 2026 report', '2026-10-13T16:30:00Z', 'Q3 2026', 2026, 3, 'Hello,

A second grant of $400K arrived in August and burn came down to $84K. Cash was $1.0M at the end of September. The equity round is still open.

Anna', 'Hello,

A second grant of $400K arrived in August and burn came down to $84K. Cash was $1.0M at the end of September. The equity round is still open.

Anna', 'complete', 'complete', 'configured_metric_extraction', 'complete', 'demo-seed-oct-2026');
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('b73915ca-2dff-52f5-9717-3ffe6385d0f9', '8596acff-4ef3-4c97-97f7-2424d73d5ec7', '35dea40d-dd6f-4916-b566-deb40872d579', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 1000000, 'high', 'e06d89ba-edd7-5083-8e6c-2369b9d0eb5d', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('5fe272a7-4dd6-5718-891c-4d65994f0259', '6aca3122-f86b-4374-b3b8-7f9c80daf173', '35dea40d-dd6f-4916-b566-deb40872d579', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 84000, 'high', 'e06d89ba-edd7-5083-8e6c-2369b9d0eb5d', 'demo-seed-oct-2026', false);
insert into metric_values (id, metric_id, company_id, fund_id, period_label, period_year, period_quarter, period_month, value_number, confidence, source_email_id, notes, is_manually_entered) values ('6c7154dc-9617-5e27-bcca-028377d2215f', '78d59428-5128-4861-8e2f-f9e9d1aabc7b', '35dea40d-dd6f-4916-b566-deb40872d579', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', 'Q3 2026', 2026, 3, null, 400000, 'high', 'e06d89ba-edd7-5083-8e6c-2369b9d0eb5d', 'demo-seed-oct-2026', false);

-- Fund I LP letters: Q2 2026 final and shared, Q3 2026 a draft that names what is missing.
insert into lp_letters (id, fund_id, template_id, period_year, period_quarter, is_year_end, period_label, portfolio_group, company_narratives, full_draft, status, created_by, created_at, updated_at, company_prompts) values ('9ace39a0-836a-54f1-9150-e54259bf9828', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '8f22fc3d-e47e-48b0-a61a-e3f077689d1c', 2026, 2, false, 'Q2 2026', 'Fund I', '[{"narrative": "NovaTech had its strongest quarter: MRR reached $331K in June, up 12% on March, with net revenue retention of 122%. The company signed its two largest enterprise contracts. Its VP Sales left in May and the CEO is covering the role. Cash was $4.1M at June 30 against monthly burn of $98K.", "company_id": "a67954cb-474b-404b-858b-49c240c22027", "updated_at": "2026-08-10T15:00:00Z", "updated_by": null, "company_name": "NovaTech"}, {"narrative": "AdVantage grew MRR 8% in the quarter to $390K, and logo churn improved to 2.6% after small accounts moved to annual contracts. The programmatic TV beta is live with four retailers. The company does not plan to raise this year.", "company_id": "d08a27bc-39e4-4fb1-a624-7a286d83e929", "updated_at": "2026-08-10T15:00:00Z", "updated_by": null, "company_name": "AdVantage"}, {"narrative": "RouteWise ended June at $6.6M ARR (March: $6.1M) with 81 customers and 69% gross margin. The London office opened in April and signed its first two UK customers. The company is planning a Series C for early 2027.", "company_id": "b4870bad-ddd4-42d1-a300-7111899cf154", "updated_at": "2026-08-10T15:00:00Z", "updated_by": null, "company_name": "RouteWise"}, {"narrative": "GreenLeaf Bio''s EPA approval has moved from Q2 2026 to the second half of 2027, after the agency asked for another field season of data. Cash was $950K at June 30, about five months of runway. The company is raising a bridge with $600K of soft commitments and has asked the fund to participate.", "company_id": "d4fef540-f26b-426f-9aef-96144a6579ce", "updated_at": "2026-08-10T15:00:00Z", "updated_by": null, "company_name": "GreenLeaf Bio"}]'::jsonb, '# Hemrock Ventures — Fund I
## Q2 2026 Portfolio Update

Dear Limited Partners,

This letter covers Fund I for the quarter ended June 30, 2026. Three of the four companies grew in the quarter; GreenLeaf Bio''s regulatory timeline slipped by more than a year, which we cover below.

---

### NovaTech

NovaTech had its strongest quarter: MRR reached $331K in June, up 12% on March, with net revenue retention of 122%. The company signed its two largest enterprise contracts. Its VP Sales left in May and the CEO is covering the role. Cash was $4.1M at June 30 against monthly burn of $98K.

---

### AdVantage

AdVantage grew MRR 8% in the quarter to $390K, and logo churn improved to 2.6% after small accounts moved to annual contracts. The programmatic TV beta is live with four retailers. The company does not plan to raise this year.

---

### RouteWise

RouteWise ended June at $6.6M ARR (March: $6.1M) with 81 customers and 69% gross margin. The London office opened in April and signed its first two UK customers. The company is planning a Series C for early 2027.

---

### GreenLeaf Bio

GreenLeaf Bio''s EPA approval has moved from Q2 2026 to the second half of 2027, after the agency asked for another field season of data. Cash was $950K at June 30, about five months of runway. The company is raising a bridge with $600K of soft commitments and has asked the fund to participate.


All performance figures are gross unless stated as net. Company figures are as reported by the companies and are unaudited.

Hemrock Ventures', 'final', 'e95bae2f-0a73-483c-9e9c-f64992e8054a', '2026-08-06T15:00:00Z', '2026-08-10T15:00:00Z', '{}'::jsonb);
insert into lp_letters (id, fund_id, template_id, period_year, period_quarter, is_year_end, period_label, portfolio_group, company_narratives, full_draft, status, created_by, created_at, updated_at, company_prompts) values ('50cf9118-52c8-57e5-82d1-5c2f3cb7e6f3', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '8f22fc3d-e47e-48b0-a61a-e3f077689d1c', 2026, 3, false, 'Q3 2026', 'Fund I', '[{"narrative": "NovaTech''s MRR reached $371K in September, up 12% on June, with net revenue retention of 124%. Burn held at $101K a month and cash was $3.8M at quarter end. A new VP Sales starts in November. Two larger deals slipped to January.", "company_id": "a67954cb-474b-404b-858b-49c240c22027", "updated_at": "2026-10-13T15:00:00Z", "updated_by": null, "company_name": "NovaTech"}, {"narrative": "AdVantage closed September at $421K MRR, up 8% on June, with 2.5% logo churn. Programmatic TV has nine paying retailers. The DSP partnership flagged last quarter did not close.", "company_id": "d08a27bc-39e4-4fb1-a624-7a286d83e929", "updated_at": "2026-10-13T15:00:00Z", "updated_by": null, "company_name": "AdVantage"}, {"narrative": "RouteWise reached $7.2M ARR at September 30 with 88 customers and 70% gross margin; Europe is 9% of new ARR. The company expects to close a Series C at a higher valuation in Q4 and has asked for the fund''s follow-on decision by the end of October.", "company_id": "b4870bad-ddd4-42d1-a300-7111899cf154", "updated_at": "2026-10-13T15:00:00Z", "updated_by": null, "company_name": "RouteWise"}, {"narrative": "GreenLeaf Bio has not sent its Q3 update. The last report (Q2) put cash at $950K with about five months of runway and a bridge round in progress.", "company_id": "d4fef540-f26b-426f-9aef-96144a6579ce", "updated_at": "2026-10-13T15:00:00Z", "updated_by": null, "company_name": "GreenLeaf Bio"}]'::jsonb, '# Hemrock Ventures — Fund I
## Q3 2026 Portfolio Update

Dear Limited Partners,

This draft covers Fund I for the quarter ended September 30, 2026. NovaTech, AdVantage and RouteWise reported; GreenLeaf Bio has not yet sent its Q3 update.

---

### NovaTech

NovaTech''s MRR reached $371K in September, up 12% on June, with net revenue retention of 124%. Burn held at $101K a month and cash was $3.8M at quarter end. A new VP Sales starts in November. Two larger deals slipped to January.

---

### AdVantage

AdVantage closed September at $421K MRR, up 8% on June, with 2.5% logo churn. Programmatic TV has nine paying retailers. The DSP partnership flagged last quarter did not close.

---

### RouteWise

RouteWise reached $7.2M ARR at September 30 with 88 customers and 70% gross margin; Europe is 9% of new ARR. The company expects to close a Series C at a higher valuation in Q4 and has asked for the fund''s follow-on decision by the end of October.

---

### GreenLeaf Bio

GreenLeaf Bio has not sent its Q3 update. The last report (Q2) put cash at $950K with about five months of runway and a bridge round in progress.

---

### Missing information

- GreenLeaf Bio: no Q3 2026 update or KPIs received (requested October 1, due October 15).
- Fund I net IRR and TVPI for the quarter have not been added to this draft.


All performance figures are gross unless stated as net. Company figures are as reported by the companies and are unaudited.

Hemrock Ventures', 'draft', 'e95bae2f-0a73-483c-9e9c-f64992e8054a', '2026-10-13T15:00:00Z', '2026-10-13T15:00:00Z', '{}'::jsonb);
insert into lp_letter_shares (letter_id, lp_investor_id, fund_id, shared_at, shared_by) values ('9ace39a0-836a-54f1-9150-e54259bf9828', '11c02811-11ad-42c8-a298-4dc11c8c82f9', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '2026-08-10T16:00:00Z', 'e95bae2f-0a73-483c-9e9c-f64992e8054a');
insert into lp_letter_shares (letter_id, lp_investor_id, fund_id, shared_at, shared_by) values ('9ace39a0-836a-54f1-9150-e54259bf9828', '38771be0-9d97-485c-a925-cba8005744af', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '2026-08-10T16:00:00Z', 'e95bae2f-0a73-483c-9e9c-f64992e8054a');
insert into lp_letter_shares (letter_id, lp_investor_id, fund_id, shared_at, shared_by) values ('9ace39a0-836a-54f1-9150-e54259bf9828', '0c458157-e6b4-4b60-8742-5403da230ba7', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '2026-08-10T16:00:00Z', 'e95bae2f-0a73-483c-9e9c-f64992e8054a');
insert into lp_letter_shares (letter_id, lp_investor_id, fund_id, shared_at, shared_by) values ('9ace39a0-836a-54f1-9150-e54259bf9828', 'ad03d815-5fc8-4b16-abf4-89d3e302e8b9', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '2026-08-10T16:00:00Z', 'e95bae2f-0a73-483c-9e9c-f64992e8054a');
insert into lp_letter_shares (letter_id, lp_investor_id, fund_id, shared_at, shared_by) values ('9ace39a0-836a-54f1-9150-e54259bf9828', 'a5d014b1-6724-4c40-a2c6-15ae95ce08ab', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '2026-08-10T16:00:00Z', 'e95bae2f-0a73-483c-9e9c-f64992e8054a');

-- Capital calls: what call #8 was for, the LPA notice period and the wire instructions.
update capital_calls set purposes = '[{"category": "investment", "amount": 1140000, "description": "Follow-on investments: GreenLeaf Bio bridge and AdVantage extension", "basis": null, "date": null}, {"category": "management_fee", "amount": 60000, "description": "Q4 2026 management fee", "basis": "2% of $12.0M commitments, Q4 2026", "date": null}]'::jsonb where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and request_key = 'demo-seed-calls-2026';
update vehicle_accounting_settings set call_notice_days = 10, call_notice_basis = 'calendar', wire_instructions = 'Bank: Pacific Commerce Bank (sample)
ABA routing: 000000000
Account name: Hemrock Ventures Fund I, L.P.
Account number: 0000000000
Reference: your investor name and the call number', updated_at = now() where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and vehicle_id = '061ee98b-cea1-465e-a73c-d597df4afaba';
update vehicle_accounting_settings set call_notice_days = 10, call_notice_basis = 'calendar', wire_instructions = 'Bank: Pacific Commerce Bank (sample)
ABA routing: 000000000
Account name: Hemrock Ventures Fund II, L.P.
Account number: 0000000000
Reference: your investor name and the call number', updated_at = now() where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and vehicle_id = 'd73f3df5-5a2f-4c34-b431-e6c8d71fd4e9';

-- A proposed Fund I call, not issued. Its due date is 7 days after the notice, inside the 10-day period,
-- so the check flags it. `checked` is empty, so the app checks it against the live register when shown.
insert into proposed_capital_calls (id, fund_id, vehicle_id, status, total, purposes, description, notice_date, due_date, stated_partners, checked, created_by, created_source, created_at, updated_at) values ('51fef79e-d5c9-5abe-9061-6efe94f32f6e', 'e2dfd2bf-ced3-4647-8277-096e616a6eab', '061ee98b-cea1-465e-a73c-d597df4afaba', 'proposed', 500000, '[{"category": "investment", "amount": 440000, "description": "RouteWise Series C pro-rata follow-on", "basis": null, "date": "2026-10-30"}, {"category": "management_fee", "amount": 60000, "description": "Q1 2027 management fee", "basis": "2% of $12.0M commitments, Q1 2027", "date": null}]'::jsonb, 'RouteWise Series C follow-on and Q1 2027 management fee', '2026-10-14', '2026-10-21', '[]'::jsonb, '{}'::jsonb, 'e95bae2f-0a73-483c-9e9c-f64992e8054a', 'demo-seed-oct-2026', '2026-10-13T16:00:00Z', '2026-10-13T16:00:00Z');

-- The reporting profile.
update fund_vehicles set strategy = 'venture', administrator = 'In-house', lp_report_days_quarterly = 45, lp_report_days_annual = 90 where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and id in ('061ee98b-cea1-465e-a73c-d597df4afaba', 'd73f3df5-5a2f-4c34-b431-e6c8d71fd4e9');
commit;
