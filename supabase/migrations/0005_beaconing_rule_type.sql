-- =============================================================================
-- 0005_beaconing_rule_type.sql — 8th anomaly rule: beaconing (DECISIONS.md §15)
--
-- Adds 'beaconing' to public.anomalies.rule_type's check constraint. This is
-- the interval-regularity (command-and-control check-in) rule that v1
-- explicitly deferred as a stretch item (§3: "meaningfully more complex than
-- the others, not required for a working v1") and §15 now implements —
-- apps/api/src/rules/beaconing.ts groups events by (cip, destination host)
-- and flags a group whose inter-arrival deltas have a low coefficient of
-- variation (a suspiciously regular cadence), distinct from burst-per-ip's
-- high-VOLUME detection axis.
--
-- Same drop-then-recreate pattern 0004_summary_pending.sql used for
-- log_files.llm_summary_status's check constraint: Postgres has no
-- `ALTER CONSTRAINT ... ADD VALUE` for a plain `check (col in (...))`
-- constraint (unlike a native enum type, which this schema deliberately
-- doesn't use here — see 0001_init.sql's plain-text + check-constraint
-- choice for rule_type), so widening the allowed set means dropping the old
-- constraint and adding a new one with the extra value included.
--
-- packages/shared/src/anomaly.ts's AnomalyRuleTypeSchema (the Zod source of
-- truth the API/frontend both import) already includes 'beaconing' — this
-- migration is what lets a real 'beaconing' row actually persist in Postgres
-- instead of failing that check constraint. Applied to local dev Postgres
-- first (required to get `logs.integration.test.ts` green again once the
-- rule engine started producing 'beaconing' anomalies — without it, the
-- full-suite `quick-demo.log` upload test failed 500 on
-- `anomalies_rule_type_check`), then to the hosted `tenexai` project
-- (`jjtmuqmzimpmkybojjdx`) as a deliberate, reviewed follow-up step.
-- =============================================================================

alter table public.anomalies
  drop constraint if exists anomalies_rule_type_check;

alter table public.anomalies
  add constraint anomalies_rule_type_check
  check (rule_type in (
    'burst_per_ip', 'bytes_out_exfil', 'threatname_hit', 'malware_category',
    'repeated_blocked', 'off_hours', 'rare_scripted_user_agent', 'beaconing'
  ));

comment on column public.anomalies.rule_type is
  'v1 rule set (7) plus beaconing, the 8th rule added in DECISIONS.md §15 — interval-regularity / C2 check-in detection (apps/api/src/rules/beaconing.ts). The rule that produced this row''s base_confidence (the max-confidence rule, if several fired on the event).';
