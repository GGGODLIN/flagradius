# FlagRadius

An agent asks to enable `new_search` for QA. It proposes turning the production default on, which would reach all 2,000 synthetic users in the FlagRadius sandbox. The MCP guard blocks the request and points to the 12-person `internal_testers` segment. Later, when a VIP loses access, the same guard evaluates the recovery after the diagnosis command finds the change in Git.

Built for Toggle Wars — entering **Track 02** (AI Agents and Feature Flags), **Track 03** (Build on Open Source Flagsmith), and **Track 04** (Flagsmith Agent Skills).

- **Demo Video (64s, 1080p30 — includes Track 04 Skill & Token Receipt)**: https://youtu.be/ucbc1Iaa-D4
- **Agent Skill (Track 04)**: [skills/flagradius-safe-rollout/SKILL.md](/skills/flagradius-safe-rollout/SKILL.md) (follows [agentskills.io/specification](https://agentskills.io/specification); verified CLI `--no-input --jq` token benchmark in [eval/demo-run-receipt.json](/skills/flagradius-safe-rollout/eval/demo-run-receipt.json))

## Run the sandbox

Install Node.js 24 or newer, Git, OpenSSL, Make, and Docker with Compose v2. Start Docker, then run this command in a terminal on the same machine as your browser.

```sh
make demo
```

`npm run demo` runs the same workflow. The command installs locked dependencies if needed, starts self-hosted Flagsmith on a loopback port, and seeds a fresh project. It generates disposable credentials in a private temporary directory. The demo needs no Flagsmith Cloud account or `.env` file.

Open the Approval Card URL printed to your terminal and enter the operator token shown alongside it. The card compares restoring `vip-acme-042` with reverting the segment change for all five VIPs. Click **Approve** to restore the single identity. The command checks that a second VIP still sees the incident state, then exercises the stale-approval and crash-recovery cases. The incident itself is staged in the disposable sandbox. The recovery card waits for your decision.

The runner tags live evidence `LIVE_FLAGSMITH`. It saves JSON receipts and an HTML copy of the card with its token redacted under `e2e-report/demo/`. It removes the Compose containers and database volume on exit. The live test gate submits the same HTML form with a scripted operator and saves the Vitest and CLI evidence separately under `e2e-report/`.

```sh
npm ci --ignore-scripts
npm test
make typecheck
make test-live-e2e
```

## Follow a change

```text
MCP client --> stdio mcp-guard --> loopback executor-daemon
                proposal token        |  |             |
                                      |  |             +--> JSONL receipts and Git snapshots
                                      |  +--> flagsmith-engine preview over the roster
Browser -- operator token ----------->|                     |
          Approval Card               +--> CLI v2 write --> Flagsmith
                                      +<-- API read-back --+
```

The MCP tool can inspect flags, submit a proposal, or invoke the sandbox's read-only diagnosis. It holds a loopback proposal token. Only the executor holds the Flagsmith management credential and accepts the separate operator token. The guard writes a receipt before invoking the pinned `@flagsmith/cli` v2.0.0, reads the environment document back from the Flagsmith API, and commits the redacted snapshot to a separate Git repository. The live sandbox also uses `flagsmith environment document` for independent CLI read-back and the transient identity API to verify the resulting evaluation. The blast-radius preview and timeline replay use `flagsmith-engine` from the pinned `@flagsmith/nodejs` SDK.

For an MCP client, launch `node --import tsx src/mcp-guard.ts` from the repository. Pass `FLAGRADIUS_EXECUTOR_URL` (a loopback HTTP origin), `FLAGRADIUS_PROPOSAL_TOKEN`, and `FLAGRADIUS_MODE=LIVE_FLAGSMITH`. The sandbox uses `inspect_flags`, `propose_flag_change`, and `diagnose_flag_incident`. A pending proposal returns an `approval_url` for the operator. The MCP environment must exclude `FLAGSMITH_API_TOKEN` and `FLAGRADIUS_HUMAN_APPROVAL_TOKEN`.

To use your own Flagsmith sandbox, set the options in [.env.example](/.env.example) in the executor's environment before running `npm run executor-daemon`. The local executor API accepts JSON on `POST /api/inspect`, `POST /api/propose`, and `POST /api/diagnose`. Authenticate with the proposal token as a bearer token. The approval form at `/approvals/<request-id>` uses the distinct operator token.

After an interrupted write, call `POST /admin/reconcile` with the operator token as a bearer token and a JSON body such as `{ "environment": "sandbox" }`. The route also accepts `application/x-www-form-urlencoded` with `token` and `environment` fields. The response reports the reconciliation status and includes the snapshot commit when it records an applied write.

## Diagnose against an existing timeline

```sh
npm run diagnose -- --env sandbox --flag new_search --identity vip-acme-042 --since 48h
```

Provide the Flagsmith API and environment settings from [.env.example](/.env.example), the snapshot directory via `FLAGRADIUS_SNAPSHOT_DIRECTORY`, and your roster via `FLAGRADIUS_ROSTER_PATH`. The roster JSON object has `roster_version` and a `roster` array of `{ "identifier", "traits", "vip" }` entries. Its version must match the recorded snapshots. For fixture replay, set `FLAGRADIUS_FIXTURE_DOCUMENT` to an environment document file. Results then carry `OFFLINE_FIXTURE_REPLAY`.

Run `npm run snapshot -- --env sandbox --init` to record a redacted Git baseline, or omit `--init` for a later manual capture. Both only read from Flagsmith.

Diagnosis walks the Git history in order so a flag that flipped more than once still yields each recorded transition. An out-of-band change can appear as a live-to-HEAD `snapshot_gap`. Diagnosis reports candidate operations and their impact. Any recovery write starts with a separate proposal.

## Agent Skill (`skills/flagradius-safe-rollout/`)

FlagRadius ships a standalone [Agent Skill](/skills/flagradius-safe-rollout/SKILL.md) built on `@flagsmith/cli` v2.0.0 and progressive disclosure ([references/cli-jq-recipes.md](/skills/flagradius-safe-rollout/references/cli-jq-recipes.md)):

- **Complete workflow**: preflight (`flagsmith config --no-input --jq`) -> compact flag & segment lookup (`flag get`, `segment list`) -> split-privilege blast-radius proposal (`BLOCKED_INTENT_MISMATCH` guard, auto-snapshotted small QA rollouts, or HTML Approval Card pause for VIP/over-budget writes) -> zero-write Git timeline diagnosis -> live read-back (`flagsmith evaluate --no-input --jq`) and one-line CLI rollback.
- **Measured token efficiency** ([demo-run-receipt.json](/skills/flagradius-safe-rollout/eval/demo-run-receipt.json)): `SKILL.md` is 50 lines (~1,110 est. tokens) without opening reference files; all 5 `--no-input --jq` CLI outputs combined total **308 bytes (~77 tokens)** vs ~11.2 KB unfiltered JSON (~97% CLI output reduction). Verified end-to-end in 3 tool calls with Claude Code (`8,691` model output tokens; `~1,595` workflow payload input tokens; `63,881` full host-harness subagent tokens).

## Boundaries

- Run one executor per environment. Flagsmith writes lack server-side compare-and-swap, so the executor serializes its own writes and checks the live baseline just before acting. External edits can still race with a write.
- Project-level changes to segment rules return `CROSS_ENV_LOCKED`. A segment rule can affect multiple environments.
- Preview fails closed when creating a segment override that inherits nonzero multivariate weights. Flagsmith assigns the state ID used for rollout bucketing at creation time.
- Reconciliation reads the live target before unlocking the environment. An ambiguous read-back or drift after a verified write keeps the environment locked for operator investigation.

[MIT License](/LICENSE)
