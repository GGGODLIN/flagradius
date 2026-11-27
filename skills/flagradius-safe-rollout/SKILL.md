---
name: flagradius-safe-rollout
description: Safely roll out, diagnose, and roll back Flagsmith feature flags using Flagsmith CLI v2 (--no-input --jq) and FlagRadius split-privilege blast-radius guarding. Use when enabling a flag for QA or a segment, triaging a VIP or customer flag regression, or applying production Flagsmith changes with human approval and Git snapshot rollback trails. Do not use for creating Flagsmith organisations/projects or modifying cross-environment segment rules.
license: MIT
compatibility: Requires Flagsmith CLI v2.0+ (flagsmith) and Node.js 24+ with FlagRadius for blast-radius previews and Git snapshot diagnosis.
metadata:
  author: gggodlin
  version: "1.0"
---

# FlagRadius Safe Rollout & Incident Recovery

Execute Flagsmith rollouts and incident triage end to end with **minimal CLI tokens**, **zero write credentials in the agent**, and **reversible Git snapshots**.

## Hard Rules

1. **Always project CLI output**: Every `flagsmith` CLI call MUST pass `--no-input` and `--jq '<compact filter>'` (`--yes --json` only on single-object writes). Never dump raw flag lists or environment documents into context.
2. **Zero write secrets in the agent**: Exclude `FLAGSMITH_API_TOKEN` and `FLAGRADIUS_HUMAN_APPROVAL_TOKEN` from agent env. Route writes through FlagRadius `mcp-guard` / `executor-daemon` (or stop for human approval before production CLI writes).
3. **Block vague production defaults**: Never flip an environment default for a QA/beta/subset request. Narrow to the exact `segment_id` or `identifier` first.
4. **Verify after every write**: Confirm live SDK resolution via `flagsmith evaluate --no-input --jq` and record the Git snapshot commit SHA.

## Workflow A — Safe Feature Flag Rollout

1. **Preflight & Compact Discovery (1 batched shell step)**:
   ```sh
   flagsmith config --no-input --jq '{apiUrl: .apiUrl.value, project: .project.value, environment: .environment.value}'
   flagsmith flag get <flag> --no-input --jq '{feature, enabled, value, segment_overrides, identity_overrides}'
   flagsmith segment list --no-input --jq '[.[] | {id, name}]'
   ```
2. **Blast-Radius Gate**: Call `propose_flag_change` (or `POST /api/propose` with `{"environment":"<env>","declared_intent":"<scope>","operation":{"type":"set_segment_override","flag_name":"<flag>","segment_id":<id>,"enabled":true,"value":"<val>"}}`).
   - `blocked` (`BLOCKED_INTENT_MISMATCH`): follow `suggested_action` and retry with the exact `segment_id`.
   - `pending_approval` (VIP hit, `>20` flips, or protected flag): **STOP** and return the one-time `approval_url`, impact counts (`+ON / -OFF / ~changed`, `vip_hits`), and `baseline_revision`. Never bypass approval.
   - `snapshotted` (small non-VIP scope `<=20` flips, `0` VIPs auto-executed via CLI v2): capture the Git snapshot commit.
3. **Read-Back & Rollback Handle**: Verify one in-scope identity and one control identity:
   ```sh
   flagsmith evaluate <flag> --identity <id> --no-input --jq '{enabled, value}'
   ```
   Include the one-line rollback: `flagsmith flag delete <flag> --segment=<id> --no-input --yes`.

## Workflow B — Put Out the Fire (Zero-Write Incident Triage)

1. **Read-Only Timeline Diagnosis**: Call `diagnose_flag_incident` (`POST /api/diagnose` with `{"environment":"<env>","flag_name":"<flag>","identifier":"<id>","since":"48h"}` or `npm run diagnose`) — **0 Flagsmith writes, 0 Git commits**. Extract `alignment`, `snapshot_gap`, culprit commit/segment, and ranked `candidate_fixes`.
2. **Minimal-Blast Recovery Proposal**: Confirm live state with `flagsmith evaluate <flag> --identity <id> --no-input --jq '{enabled, value}'`, then call `propose_flag_change` with the smallest-radius fix (`set_identity_override`, `declared_intent` naming the single identity). Hand the `pending_approval` Approval Card URL (`baseline_revision` CAS-guarded; drift aborts with `stale_approval` and `0` writes) to the operator.
3. **Post-Approval Verification**: After human approval runs CLI v2, verify both the restored identity and an unaffected peer via `flagsmith evaluate --no-input --jq`.

## Crash Safety

If FlagRadius returns `ENV_CRASH_LOCKED` after an interrupted write, do **not** retry. Direct the operator to call `POST /admin/reconcile` with the separate operator token.

Read [references/cli-jq-recipes.md](references/cli-jq-recipes.md) only when exact Flagsmith CLI v2 flags or self-hosted host-scoped env var syntax are needed.
