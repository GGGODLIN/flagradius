# FlagRadius — Toggle Wars: Flagsmith Track 02

Single-environment AI agent safety control plane for Flagsmith (Pre-Write Blast-Radius MCP Guard + Post-Write Snapshot Timeline Diagnosis).

## Conventions

- TypeScript ESM (`"type": "module"`), 2-space indentation, pure functions where possible, `??` over `||`.
- Never commit `.env`, API keys, `.scratch/`, or `.flagradius-state/` runtime snapshots/receipts.
- All outputs (CLI, MCP payloads, receipts, Approval UI) must tag `mode: "LIVE_FLAGSMITH" | "OFFLINE_FIXTURE_REPLAY"`.
- `mcp-guard` must hold zero `FLAGSMITH_API_TOKEN` and expose zero approval endpoints; only `executor-daemon` holds write credentials.
