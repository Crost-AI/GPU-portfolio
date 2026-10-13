-- Removes demo-seed-oct-2026: the letters (their shares cascade), the Q3 request, the proposed call, the KPI
-- values and company updates it filed (and the emails they came from), and puts call #8's purposes,
-- the notice period, the wire instructions and the reporting profile back to unset.
begin;
delete from lp_letters where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and id in ('9ace39a0-836a-54f1-9150-e54259bf9828', '50cf9118-52c8-57e5-82d1-5c2f3cb7e6f3');
delete from email_requests where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and id = '57e6d20e-86e2-56f7-bd43-64c128370bef';
delete from proposed_capital_calls where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and created_source = 'demo-seed-oct-2026';
delete from metric_values where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and notes = 'demo-seed-oct-2026';
delete from company_updates where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and parser_version = 'demo-seed-oct-2026';
delete from inbound_emails where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and raw_payload->>'demo_seed' = 'demo-seed-oct-2026';
update capital_calls set purposes = null where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and request_key = 'demo-seed-calls-2026';
update vehicle_accounting_settings set call_notice_days = null, call_notice_basis = null, wire_instructions = null, updated_at = now() where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and vehicle_id in ('061ee98b-cea1-465e-a73c-d597df4afaba', 'd73f3df5-5a2f-4c34-b431-e6c8d71fd4e9');
update fund_vehicles set strategy = null, administrator = null, lp_report_days_quarterly = null, lp_report_days_annual = null where fund_id = 'e2dfd2bf-ced3-4647-8277-096e616a6eab' and id in ('061ee98b-cea1-465e-a73c-d597df4afaba', 'd73f3df5-5a2f-4c34-b431-e6c8d71fd4e9');
commit;
