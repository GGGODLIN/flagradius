import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startExecutorDaemon } from '../src/executor-daemon.js';
import { document, flag, roster, rule, state } from './fixtures.js';
import { environment, mode, setup } from './guard-fixture.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const mcpEntry = fileURLToPath(new URL('../src/mcp-guard.ts', import.meta.url));
const proposalToken = 'test-proposal-token';
const humanApprovalToken = 'test-operator-token';
const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const query = { environment, flag_name: flag, identifier: roster[2].identifier };
const body = (token: string) => new URLSearchParams({ token });
const payload = (result: Awaited<ReturnType<Client['callTool']>>) => result.structuredContent as Record<string, unknown> | undefined;

function mcpTransport(origin: string, env: Record<string, string> = {}) {
  return new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', mcpEntry], cwd: root, stderr: 'pipe',
    env: { FLAGRADIUS_EXECUTOR_URL: origin, FLAGRADIUS_PROPOSAL_TOKEN: proposalToken, ...env },
  });
}

let fixture: ReturnType<typeof setup>;
let daemon: Awaited<ReturnType<typeof startExecutorDaemon>>;
let client: Client;

beforeEach(async () => {
  fixture = setup({ roster });
  fixture.backend.live.project.segments = [{ id: 12, name: 'internal_testers', rules: [rule('cohort', 'internal_testers')], feature_states: [] }];
  daemon = await startExecutorDaemon({
    engine: fixture.engine, receiptStore: fixture.receiptStore, environments: fixture.options.environments,
    proposalToken, humanApprovalToken,
    onDiagnose: ({ identifier }) => ({
      status: 'diagnosed', snapshot_gap: true, alignment: 'aligned',
      identifier, traits: roster[0].traits, candidates: [{ segment_id: 12, name: 'internal_testers', identifier: roster[0].identifier }],
    }),
  });
  client = new Client({ name: 'approval-test', version: '1.0.0' });
  await client.connect(mcpTransport(daemon.origin));
});

afterEach(async () => {
  try {
    await client?.close();
    await daemon?.close();
  } finally {
    fixture?.cleanup();
  }
});

const propose = (operation: Record<string, unknown> = { type: 'set_environment_default', flag_name: flag, enabled: true }, declared_intent = 'everyone') =>
  client.callTool({ name: 'propose_flag_change', arguments: { environment, declared_intent, operation } });

async function pendingUrl() {
  const result = await propose();
  expect(result.structuredContent).toMatchObject({ status: 'pending_approval' });
  const url = String(payload(result)?.approval_url);
  expect(new URL(url).origin).toBe(daemon.origin);
  return url;
}

describe('split-privilege MCP and human approval', () => {
  it('boots a credential-free MCP toolset and rejects the proposal token on both decision routes', async () => {
    const tools = (await client.listTools()).tools.map(({ name }) => name);
    expect(tools.sort()).toEqual(['diagnose_flag_incident', 'inspect_flags', 'propose_flag_change']);

    const contaminated = new Client({ name: 'contaminated-test', version: '1.0.0' });
    const syntheticToken = 'synthetic-provider-credential';
    const transport = mcpTransport(daemon.origin, { FLAGSMITH_API_TOKEN: syntheticToken });
    let stderr = '';
    transport.stderr?.on('data', chunk => { stderr += chunk.toString(); });
    try {
      await expect(contaminated.connect(transport)).rejects.toThrow();
      expect(stderr.includes('MCP_STARTUP_FAILED')).toBe(true);
      expect(stderr.includes(syntheticToken)).toBe(false);
    } finally {
      await contaminated.close();
    }

    const url = await pendingUrl();
    for (const action of ['approve', 'reject']) {
      const forbidden = await fetch(`${url}/${action}`, { method: 'POST', headers: auth(proposalToken), body: body(humanApprovalToken) });
      expect(forbidden.status).toBe(403);
      const forbiddenForm = await fetch(`${url}/${action}`, { method: 'POST', body: body(proposalToken) });
      expect(forbiddenForm.status).toBe(403);
    }
    expect(fixture.backend.live.feature_states[0].enabled).toBe(false);
    expect(fixture.backend.writes).toHaveLength(0);
    const unlocked = await fetch(url, { method: 'POST', body: body(humanApprovalToken) });
    expect(await unlocked.text()).toContain('>Approve</button>');
  });

  it('returns concrete flag, candidate segment, reason and impact metadata without roster data', async () => {
    const inspection = await client.callTool({ name: 'inspect_flags', arguments: { environment } });
    expect(inspection.structuredContent).toMatchObject({
      mode, request_id: expect.any(String), flags: [{ name: flag, enabled: false }],
      candidates: [{ segment_id: 12, name: 'internal_testers' }],
      total_evaluated: 0, flipped_on: 0, flipped_off: 0, value_changed: 0, vip_hits: 0, reason_codes: [],
    });
    const mismatch = await propose(undefined, 'QA');
    expect(mismatch.structuredContent).toMatchObject({
      mode, request_id: expect.any(String), status: 'blocked', reason_codes: ['BLOCKED_INTENT_MISMATCH'],
      candidates: [{ segment_id: 12, name: 'internal_testers' }],
      suggested_action: { type: 'set_segment_override', segment_id: 12, name: 'internal_testers' },
    });
    const pending = await propose();
    expect(pending.structuredContent).toMatchObject({
      mode, request_id: expect.any(String), status: 'pending_approval', total_evaluated: 3,
      flipped_on: 3, flipped_off: 0, value_changed: 0, vip_hits: 1, reason_codes: ['VIP_IMPACT'],
    });
    expect(String(payload(pending)?.approval_url)).toBe(`${daemon.origin}/approvals/${payload(pending)?.request_id}`);
    const diagnosis = await client.callTool({ name: 'diagnose_flag_incident', arguments: query });
    expect(diagnosis.structuredContent).toMatchObject({
      mode, status: 'diagnosed', snapshot_gap: true, alignment: 'aligned', candidates: [{ segment_id: 12, name: 'internal_testers' }],
    });
    const optedIn = await client.callTool({ name: 'diagnose_flag_incident', arguments: { ...query, echo_identifier: true } });
    expect(payload(optedIn)?.identifier).toBe(query.identifier);
    expect(JSON.stringify(diagnosis).includes(query.identifier)).toBe(false);
    expect(JSON.stringify(optedIn).includes(roster[0].identifier)).toBe(false);
    expect(fixture.backend.writes).toHaveLength(0);
  });

  it('renders escaped long names, evaluation details and both decision forms for a human', async () => {
    const flagName = `search_${'x'.repeat(80)}<&`;
    const segmentName = `QA_${'y'.repeat(80)}<&`;
    fixture.backend.live.feature_states = [state(false, { feature: { ...state(false).feature, name: flagName } })];
    fixture.backend.live.project.segments[0].name = segmentName;
    const pending = await propose({ type: 'set_segment_override', flag_name: flagName, enabled: true, segment_id: 12 }, segmentName);
    const url = String(payload(pending)?.approval_url);
    const locked = await fetch(url);
    expect((await locked.text()).includes(humanApprovalToken)).toBe(false);
    const approval = await fetch(url, { headers: auth(humanApprovalToken) });
    const html = await approval.text();
    expect(approval.headers.get('content-type')).toContain('text/html');
    for (const field of [
      'Impact Approval Card', environment, flagName.replace('<&', '&lt;&amp;'), segmentName.replace('<&', '&lt;&amp;'),
      '+ON 2', '-OFF 0', '~value_changed 0', 'Evaluated roster', '>3<', 'VIP hits', '>1<', 'VIP_IMPACT',
      'Baseline revision', String(payload(pending)?.request_id), mode, 'overflow-wrap: anywhere',
      '/approve"', '/reject"', '>Approve</button>', '>Reject</button>',
    ]) expect(html).toContain(field);
    expect(html.includes(flagName)).toBe(false);
  });

  it('executes once per card and shows already_approved, rejected and stale_approval', async () => {
    const post = async (url: string, action: string) => (await fetch(`${url}/${action}`, { method: 'POST', body: body(humanApprovalToken) })).text();
    const rejected = await pendingUrl();
    expect(await post(rejected, 'reject')).toContain('>rejected<');
    expect(await post(rejected, 'approve')).toContain('>rejected<');
    expect(fixture.backend.writes).toHaveLength(0);

    const stale = await pendingUrl();
    fixture.backend.live.feature_states[0].feature_state_value = 'changed out of band';
    expect(await post(stale, 'approve')).toContain('>stale_approval<');
    expect(await post(stale, 'approve')).toContain('>stale_approval<');
    expect(fixture.backend.writes).toHaveLength(0);

    const approved = await pendingUrl();
    const results = await Promise.all([post(approved, 'approve'), post(approved, 'approve')]);
    expect(results.filter(html => html.includes('>snapshotted<'))).toHaveLength(1);
    expect(results.filter(html => html.includes('>already_approved<'))).toHaveLength(1);
    expect(await post(approved, 'approve')).toContain('>already_approved<');
    expect(fixture.backend.writes).toHaveLength(1);
    expect(fixture.backend.live.feature_states[0].enabled).toBe(true);
  });

  it('returns structured invalid-argument errors and keeps serving commands', async () => {
    for (const [name, args] of [
      ['inspect_flags', { environment: 123 }],
      ['propose_flag_change', { environment, declared_intent: 'everyone', operation: { type: 'set_environment_default', flag_name: flag, enabled: 'true' } }],
      ['diagnose_flag_incident', { environment, flag_name: flag }],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ mode, request_id: expect.any(String), reason_codes: ['INVALID_ARGUMENTS'], total_evaluated: 0 });
    }
    expect((await client.callTool({ name: 'inspect_flags', arguments: { environment } })).structuredContent).toMatchObject({ flags: [{ name: flag, enabled: false }] });
    expect(fixture.backend.writes).toHaveLength(0);
  });

  it.each(['SIGINT', 'SIGTERM'] as const)('shuts down both real processes cleanly on %s', async signal => {
    const transport = mcpTransport(daemon.origin);
    const connected = new Client({ name: 'signal-test', version: '1.0.0' });
    await connected.connect(transport);
    try {
      const pid = transport.pid!;
      const closed = new Promise<void>(resolve => { connected.onclose = resolve; });
      process.kill(pid, signal);
      await closed;
      expect(() => process.kill(pid, 0)).toThrow();
    } finally {
      await connected.close();
    }

    const apiToken = 'synthetic-daemon-only-token';
    const doc = document();
    const provider = createServer((request, response) => {
      if (request.url !== `/api/v1/environments/${doc.api_key}/document/` || request.headers.authorization !== `Api-Key ${apiToken}`) {
        response.writeHead(403).end();
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(doc));
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    const providerPort = (provider.address() as AddressInfo).port;
    const daemonEntry = fileURLToPath(new URL('../src/executor-daemon.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', daemonEntry], {
      cwd: root, stdio: ['ignore', 'pipe', 'ignore'], env: {
        ...getDefaultEnvironment(), FLAGSMITH_API_TOKEN: apiToken, FLAGSMITH_API_URL: `http://127.0.0.1:${providerPort}`,
        FLAGSMITH_PROJECT_ID: String(doc.project.id), FLAGSMITH_ENVIRONMENT_KEY: doc.api_key,
        FLAGRADIUS_ENVIRONMENT: environment, FLAGRADIUS_PROPOSAL_TOKEN: proposalToken,
        FLAGRADIUS_HUMAN_APPROVAL_TOKEN: humanApprovalToken, FLAGRADIUS_EXECUTOR_PORT: '0',
      },
    });
    const exited = once(child, 'exit');
    const stdout = createInterface({ input: child.stdout! });
    try {
      const [line] = await Promise.race([once(stdout, 'line'), exited.then(() => { throw new Error('Executor exited before listening.'); })]);
      const ready = JSON.parse(line);
      expect(ready).toMatchObject({ status: 'listening', mode: 'LIVE_FLAGSMITH' });
      const endpoint = `${ready.origin}/api/inspect`;
      const inspected = await fetch(endpoint, { method: 'POST', headers: { ...auth(proposalToken), 'content-type': 'application/json' }, body: JSON.stringify({ environment }) });
      expect(inspected.status).toBe(200);
      expect(await inspected.json()).toMatchObject({ mode: 'LIVE_FLAGSMITH', flags: [{ name: flag, enabled: false }] });
      child.kill(signal);
      expect(await exited).toEqual([0, null]);
      await expect(fetch(endpoint)).rejects.toThrow();
    } finally {
      stdout.close();
      child.kill('SIGKILL');
      try { await exited; } finally { await new Promise<void>(resolve => provider.close(() => resolve())); }
    }
  });
});
