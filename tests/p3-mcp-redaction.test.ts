import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import fc from 'fast-check';
import { expect, test } from 'vitest';
import { startExecutorDaemon } from '../src/executor-daemon.js';
import { flag, rule, state } from './fixtures.js';
import { environment, mode, setup } from './guard-fixture.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = fileURLToPath(new URL('../src/mcp-guard.ts', import.meta.url));
const proposalToken = 'p3-synthetic-proposal-token';
const humanApprovalToken = 'p3-synthetic-operator-token';
const segment = { segment_id: 9, name: 'qa' };
const counts = { total_evaluated: 1, total_flipped: 1, flipped_on: 1, flipped_off: 0, value_changed: 0, vip_hits: 1 };

function privacyResult(wire: unknown, roster: { identifier: string; traits: Record<string, string | number | boolean | null> }[]) {
  const serialized = JSON.stringify(wire);
  return {
    identifiersHidden: !roster.some(({ identifier }) => serialized.includes(identifier)),
    traitsHidden: !roster.some(({ traits }) => Object.entries(traits)
      .some(([key, value]) => serialized.includes(key) || serialized.includes(String(value)))),
  };
}

const people = fc.uniqueArray(fc.tuple(fc.uuid(), fc.boolean()), { minLength: 1, maxLength: 100, selector: ([id]) => id })
  .map(entries => entries.map(([id, vip]) => ({
    identifier: `private-user-${id}`, traits: { [`private-trait-${id}`]: `private-value-${id}` }, vip,
  })));

test('P3 hides generated roster identifiers and traits throughout MCP structured and text payloads', async () => {
  await fc.assert(fc.asyncProperty(people, async roster => {
    const first = roster[0];
    const last = roster.at(-1)!;
    const privateFields = { identifier: last.identifier, traits: first.traits };
    const fixture = setup({ roster, protected_flags: [flag] });
    const doc = fixture.backend.live;
    doc.feature_states[0].metadata = privateFields;
    doc.feature_states[0].feature_state_value = Object.values(first.traits)[0];
    doc.identity_overrides = [{ ...privateFields, identity_features: [state(false)] }];
    doc.project.segments = [{ id: segment.segment_id, name: segment.name,
      rules: [rule(Object.keys(first.traits)[0], Object.values(first.traits)[0])], feature_states: [] }];
    const client = new Client({ name: 'p3-test', version: '1.0.0' });
    const daemon = await startExecutorDaemon({
      engine: fixture.engine, receiptStore: fixture.receiptStore, environments: fixture.options.environments, proposalToken, humanApprovalToken,
      onDiagnose: () => ({
        ...privateFields, candidates: [{ ...segment, ...privateFields }],
        candidate_fixes: [{ type: 'set_identity_override', operation: privateFields, blast_radius: { ...counts, ...privateFields } }],
        alignment: 'aligned', snapshot_gap: false,
      }),
    });
    try {
      await client.connect(new StdioClientTransport({
        command: process.execPath, args: ['--import', 'tsx', entry], cwd: root, stderr: 'pipe',
        env: { FLAGRADIUS_EXECUTOR_URL: daemon.origin, FLAGRADIUS_PROPOSAL_TOKEN: proposalToken },
      }));
      const inspection = await client.callTool({ name: 'inspect_flags', arguments: { environment } });
      const proposal = await client.callTool({ name: 'propose_flag_change', arguments: {
        environment, declared_intent: first.identifier,
        operation: { type: 'set_identity_override', identifier: first.identifier, flag_name: flag, enabled: true },
      } });
      const query = { environment, flag_name: flag, identifier: first.identifier };
      const diagnosis = await client.callTool({ name: 'diagnose_flag_incident', arguments: query });
      const legacyOptIn = await client.callTool({ name: 'diagnose_flag_incident', arguments: { ...query, echo_identifier: true } });
      expect(inspection.structuredContent).toMatchObject({ status: 'inspected', flags: [{ name: flag, enabled: false }], candidates: [segment] });
      expect(proposal.structuredContent).toMatchObject({
        status: 'pending_approval', mode, total_evaluated: roster.length, flipped_on: 1, flipped_off: 0,
        value_changed: 0, vip_hits: Number(first.vip), reason_codes: expect.arrayContaining(['PROTECTED_FLAG']),
        approval_url: expect.stringContaining(`${daemon.origin}/approvals/`),
      });
      expect(diagnosis.structuredContent).toMatchObject({ status: 'diagnosed', candidates: [segment], alignment: 'aligned',
        candidate_fixes: [{ type: 'set_identity_override', blast_radius: counts }],
      });
      expect(legacyOptIn.structuredContent).toMatchObject({ status: 'error', code: 'INVALID_ARGUMENTS' });
      for (const response of [inspection, proposal, diagnosis, legacyOptIn]) {
        expect(privacyResult(response.structuredContent, roster)).toEqual({ identifiersHidden: true, traitsHidden: true });
        expect(privacyResult(response.content, roster)).toEqual({ identifiersHidden: true, traitsHidden: true });
      }
    } finally {
      try { await client.close(); await daemon.close(); } finally { fixture.cleanup(); }
    }
  }), { numRuns: 24, seed: 20261125 });
}, 30_000);

test('calibrates the P3 oracle against independently leaked identifiers and traits at either response depth', () => {
  const roster = [{ identifier: 'private-user-oracle', traits: { 'private-key-oracle': 'private-value-oracle' } }];
  const safe = { structuredContent: { status: 'diagnosed', candidates: [segment] }, content: [{ type: 'text', text: JSON.stringify({ candidates: [segment] }) }] };
  expect(privacyResult(safe, roster)).toEqual({ identifiersHidden: true, traitsHidden: true });
  for (const [invariant, otherInvariant, privateField] of [
    ['identifiersHidden', 'traitsHidden', { identifier: roster[0].identifier }],
    ['traitsHidden', 'identifiersHidden', { traits: roster[0].traits }],
  ] as const) {
    const leakedTopLevel = { ...safe, structuredContent: { ...safe.structuredContent, ...privateField } };
    const leakedNestedText = { ...safe, content: [{ type: 'text', text: JSON.stringify({ candidates: [{ ...segment, ...privateField }] }) }] };
    for (const mutant of [leakedTopLevel, leakedNestedText]) {
      expect(privacyResult(mutant, roster)[invariant]).toBe(false);
      expect(privacyResult(mutant, roster)[otherInvariant]).toBe(true);
    }
  }
});
