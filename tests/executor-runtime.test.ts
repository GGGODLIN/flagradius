import { writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildExecutorRuntime, startExecutorDaemon } from '../src/executor-daemon.js';
import { generateRoster } from '../src/roster.js';
import { document, flag, roster, state } from './fixtures.js';
import { environment, setup } from './guard-fixture.js';

const mode = 'LIVE_FLAGSMITH';
const proposalToken = 'synthetic-proposal-runtime';
const humanApprovalToken = 'synthetic-operator-runtime';
const apiToken = 'synthetic-provider-runtime';
const customIdentity = { ...roster[1], identifier: 'synthetic-runtime-only' };
const version = 'runtime-roster-v1';
const doc = document();
const cleanups: Array<() => void | Promise<void>> = [];
let fixture: ReturnType<typeof setup>;
let env: NodeJS.ProcessEnv;
let rosterPath: string;

beforeEach(() => {
  fixture = setup();
  cleanups.push(fixture.cleanup);
  const directory = dirname(dirname(fixture.receiptStore.path));
  rosterPath = join(directory, 'roster.json');
  env = {
    FLAGSMITH_API_URL: 'http://127.0.0.1:1', FLAGSMITH_API_TOKEN: apiToken,
    FLAGSMITH_PROJECT_ID: String(doc.project.id), FLAGSMITH_ENVIRONMENT_KEY: doc.api_key,
    FLAGRADIUS_ENVIRONMENT: environment, FLAGRADIUS_EXECUTOR_PORT: '0',
    FLAGRADIUS_STATE_DIR: dirname(fixture.receiptStore.path), FLAGRADIUS_ROSTER_PATH: rosterPath,
    FLAGRADIUS_PROPOSAL_TOKEN: proposalToken, FLAGRADIUS_HUMAN_APPROVAL_TOKEN: humanApprovalToken,
  };
  writeFileSync(rosterPath, JSON.stringify({ roster: [customIdentity], roster_version: version }));
});

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startProvider(documentBody: unknown = doc) {
  const calls: string[] = [];
  const identities: unknown[] = [];
  const server = createServer(async (request, response) => {
    calls.push(request.method ?? '');
    response.setHeader('content-type', 'application/json');
    if (request.url === `/api/v1/environments/${doc.api_key}/document/` && request.headers.authorization === `Api-Key ${apiToken}`) {
      response.end(JSON.stringify(documentBody));
    } else if (request.url === '/api/v1/identities/' && request.headers['x-environment-key'] === doc.api_key) {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      identities.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      response.end(JSON.stringify({ flags: [state(false)], traits: [{ trait_key: 'cohort', trait_value: 'internal_testers' }] }));
    } else {
      response.writeHead(403).end('{}');
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  env.FLAGSMITH_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { calls, identities };
}

async function startRuntime() {
  const runtime = await buildExecutorRuntime(env);
  const daemon = await startExecutorDaemon(runtime);
  cleanups.push(daemon.close);
  return {
    runtime,
    post: (route: string, body: unknown) => fetch(`${daemon.origin}/api/${route}`, {
      method: 'POST', headers: { authorization: `Bearer ${proposalToken}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
    }),
  };
}

const makeProposal = (enabled: boolean) => ({
  environment, declared_intent: 'everyone', operation: { type: 'set_environment_default', flag_name: flag, enabled },
});

test('standalone policy loads its configured roster, protected flags and zero-flip budget', async () => {
  const provider = await startProvider();
  env.FLAGRADIUS_PROTECTED_FLAGS = ` , ${flag} , another_flag, `;
  env.FLAGRADIUS_MAX_SINGLE_AUTO_FLIPS = '0';
  const { runtime, post } = await startRuntime();
  for (const enabled of [false, true]) {
    const response = await post('propose', makeProposal(enabled));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'pending_approval', total_evaluated: 1, total_flipped: Number(enabled),
      reason_codes: enabled ? ['OVER_BUDGET', 'PROTECTED_FLAG'] : ['PROTECTED_FLAG'],
    });
  }
  expect(runtime.receiptStore.readAll().filter(receipt => receipt.status === 'pending_approval').map(receipt => receipt.plan.roster_version))
    .toEqual([version, version]);
  expect(provider.calls).toEqual(['GET', 'GET']);
});

test('standalone without a roster path uses the synthetic roster and honors an explicit version', async () => {
  await startProvider();
  for (const rosterVersion of [undefined, 'synthetic-override']) {
    const runtime = await buildExecutorRuntime({ ...env, FLAGRADIUS_ROSTER_PATH: undefined, FLAGRADIUS_ROSTER_VERSION: rosterVersion });
    expect(await runtime.engine.proposeChange(makeProposal(true))).toMatchObject({
      status: 'pending_approval', blast_radius: { total_evaluated: generateRoster().length },
    });
    expect(runtime.receiptStore.readAll().at(-1)).toMatchObject({ status: 'pending_approval',
      plan: { roster_version: rosterVersion ?? 'synthetic-v1' },
    });
  }
});

test('standalone startup rejects missing or malformed configured rosters and invalid auto-approval budgets', async () => {
  await expect(buildExecutorRuntime({ ...env, FLAGRADIUS_ROSTER_PATH: `${rosterPath}.missing` }))
    .rejects.toMatchObject({ mode, code: 'INVALID_ROSTER' });
  for (const invalid of ['{', JSON.stringify({ roster: [customIdentity, customIdentity], roster_version: version })]) {
    writeFileSync(rosterPath, invalid);
    await expect(buildExecutorRuntime(env)).rejects.toMatchObject({ mode, code: 'INVALID_ROSTER' });
  }
  for (const limit of ['', '-1', '1.5', '1e1', '9007199254740992']) {
    await expect(buildExecutorRuntime({ ...env, FLAGRADIUS_ROSTER_PATH: undefined, FLAGRADIUS_MAX_SINGLE_AUTO_FLIPS: limit }))
      .rejects.toMatchObject({ mode, code: 'INVALID_CONFIGURATION' });
  }
});

test('standalone diagnosis reads its configured roster, Git snapshot and transient live evaluation', async () => {
  const provider = await startProvider();
  fixture.snapshotStore.commitSnapshot({ document: doc, environment, mode, request_id: 'synthetic-runtime-snapshot', roster_version: version });
  const { post } = await startRuntime();
  const response = await post('diagnose', { environment, flag_name: flag, identifier: customIdentity.identifier, since: '48h' });
  expect(response.status).toBe(200);
  const payload = await response.json();
  expect(payload).toMatchObject({ status: 'diagnosed', mode, alignment: 'aligned', snapshot_gap: false, candidate_fixes: [] });
  expect(JSON.stringify(payload).includes(customIdentity.identifier)).toBe(false);
  expect(provider.calls).toEqual(['GET', 'POST']);
  expect(provider.identities).toEqual([{ identifier: customIdentity.identifier, transient: true,
    traits: [{ trait_key: 'cohort', trait_value: 'internal_testers', transient: true }],
  }]);
});

test('standalone inspect returns 502 INVALID_DOCUMENT for malformed nested feature state', async () => {
  await startProvider({ ...doc, feature_states: [{ ...doc.feature_states[0], enabled: 'yes' }] });
  const { runtime, post } = await startRuntime();
  await expect(runtime.environments[environment].fetchEnvironmentDocument()).rejects.toMatchObject({ mode, code: 'INVALID_DOCUMENT' });
  const response = await post('inspect', { environment });
  expect(response.status).toBe(502);
  const payload = await response.json();
  expect(payload).toMatchObject({ status: 'error', mode, code: 'INVALID_DOCUMENT' });
  expect(payload).not.toHaveProperty('flags');
});
