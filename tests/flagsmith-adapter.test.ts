import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from 'vitest';
import { FlagsmithAdapter } from '../src/flagsmith-adapter.js';
import { FlagsmithError } from '../src/types.js';
import { document, flag, rule, state } from './fixtures.js';

const fakeToken = 'synthetic.only-test-token';
const adapter = (apiUrl = 'http://127.0.0.1:1/api/v1/') => new FlagsmithAdapter({
  apiUrl, apiToken: fakeToken, projectId: 8, environmentKey: 'synthetic-env-key', timeoutMs: 3000,
});

test('an enabled-only preview preserves the default value and leaves the input unchanged', () => {
  const before = document();
  const result = adapter().applyOperationToDocument(before, { type: 'set_environment_default', flag_name: flag, enabled: true });
  expect(result.feature_states).toEqual([state(true)]);
  expect(before.feature_states).toEqual([state(false)]);
});

test('a value-only segment preview inherits default enabled and joins after existing overrides', () => {
  const before = document(true);
  before.project.segments.push(
    { id: 2, name: 'existing', rules: [rule('cohort', 'existing')], feature_states: [state(false, { feature_segment: { priority: 7 } })] },
    { id: 3, name: 'new', rules: [rule('cohort', 'new')], feature_states: [] },
  );
  const result = adapter().applyOperationToDocument(before, { type: 'set_segment_override', flag_name: flag, segment_id: 3, value: 'new' });
  expect(result.project.segments[1].feature_states[0]).toMatchObject({ enabled: true, feature_state_value: 'new', feature_segment: { priority: 8 } });
  expect(result.project.segments[0].feature_states).toEqual(before.project.segments[0].feature_states);
});

test.each([401, 403, 503])('live read fails closed with a redacted structured HTTP %s error', async (status) => {
  let tokenReachedServer = false;
  const server = createServer((req, res) => {
    tokenReachedServer = Object.values(req.headers).some(header => String(header).includes(fakeToken));
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ detail: fakeToken }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const failure: unknown = await adapter(`http://127.0.0.1:${port}/api/v1/`).fetchEnvironmentDocument().catch((error: unknown) => error);
    expect(tokenReachedServer).toBe(true);
    expect(failure instanceof FlagsmithError).toBe(true);
    if (!(failure instanceof FlagsmithError)) throw new Error('missing structured error');
    expect(failure.status).toBe(status);
    expect(failure.mode).toBe('LIVE_FLAGSMITH');
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure)).includes(fakeToken), 'synthetic token was echoed').toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 8000);

test('an unreachable server never falls back to a fixture', async () => {
  await expect(adapter().fetchEnvironmentDocument()).rejects.toMatchObject({ mode: 'LIVE_FLAGSMITH', code: 'LIVE_UNAVAILABLE' });
});

test('after a successful pre-read, a real CLI 403 fails the write without echoing the token', async () => {
  let cliReachedServer = false;
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/v1/environments/synthetic-env-key/document/') {
      res.end(JSON.stringify(document()));
    } else {
      cliReachedServer = req.headers.authorization === `Api-Key ${fakeToken}`;
      res.writeHead(403).end(JSON.stringify({ detail: fakeToken }));
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const { port } = server.address() as AddressInfo;
    const failure: unknown = await adapter(`http://127.0.0.1:${port}`).execute({
      type: 'set_environment_default', flag_name: flag, enabled: true,
    }).catch((error: unknown) => error);
    expect(cliReachedServer).toBe(true);
    expect(failure instanceof FlagsmithError).toBe(true);
    if (!(failure instanceof FlagsmithError)) throw new Error('missing structured CLI error');
    expect(failure.mode).toBe('LIVE_FLAGSMITH');
    expect(failure.status).toBe(403);
    expect(JSON.stringify(failure, Object.getOwnPropertyNames(failure)).includes(fakeToken), 'synthetic token was echoed by CLI adapter').toBe(false);
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}, 8000);
