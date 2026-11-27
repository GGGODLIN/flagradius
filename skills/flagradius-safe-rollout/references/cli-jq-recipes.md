# Flagsmith CLI v2 `--no-input --jq` Token-Saving Recipes

Use these exact `@flagsmith/cli` v2.0.0 invocations when running the `flagradius-safe-rollout` workflow. Every read projects only the fields needed for decision-making to avoid multi-kilobyte JSON dumps.

## 1. Compact Read Commands

For self-hosted Flagsmith instances, `@flagsmith/cli` v2.0.0 uses host-scoped environment variables (`FLAGSMITH_API_KEY_<HOST>_<PORT>`, e.g. `FLAGSMITH_API_KEY_127_0_0_1_8000`) with `{prefix}.{secret}` format.

```sh
# Resolved project/environment context (~90 bytes)
flagsmith config --no-input --jq '{apiUrl: .apiUrl.value, project: .project.value, environment: .environment.value}'

# Single flag summary (~95 bytes vs ~2–4 KB raw)
flagsmith flag get new_search --no-input \
  --jq '{feature, enabled, value, segment_overrides, identity_overrides}'

# Segment ID lookup table (~65 bytes vs ~6 KB with full rule trees)
flagsmith segment list --no-input --jq '[.[] | {id, name}]'

# Single-identity live verification (~35 bytes)
flagsmith evaluate new_search --identity qa-01 --no-input --jq '{enabled, value}'

# CI / deploy boolean gate (exit 0 when enabled, non-zero when disabled)
flagsmith evaluate new_search --identity qa-01 --no-input --test
```

## 2. Scoped Write & Rollback Commands (Executed by FlagRadius Executor or Approved Operator)

```sh
# Enable a flag for one segment only (never touches environment default)
flagsmith flag update new_search --segment=3 --enable --value=v2 --type=string --no-input --yes --json

# Surgical single-VIP identity recovery override (1 user affected vs 5-user segment revert)
flagsmith flag update new_search --identifier=vip-acme-042 --enable --value=v2 --type=string --no-input --yes --json

# Instant segment override rollback
flagsmith flag delete new_search --segment=3 --no-input --yes

# Instant identity override cleanup
flagsmith flag delete new_search --identifier=vip-acme-042 --no-input --yes
```

## 3. Git Snapshot & Read-Only Timeline Diagnosis (FlagRadius)

```sh
# Capture a redacted Git baseline snapshot (read-only against Flagsmith)
npm run snapshot -- --env sandbox --init

# Replay Git snapshots to pinpoint culprit commit & rank recovery blast radius (0 writes)
npm run diagnose -- --env sandbox --flag new_search --identity vip-acme-042 --since 48h
```
