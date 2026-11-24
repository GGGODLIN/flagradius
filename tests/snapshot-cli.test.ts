import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { generateRoster } from '../src/roster.js';
import { runSnapshotCli } from '../src/snapshot-cli.js';
import { diagnoseTimeline } from '../src/timeline-diagnose.js';
import { document, flag, roster, state } from './fixtures.js';
import { environment, mode, setup } from './guard-fixture.js';

let fixture: ReturnType<typeof setup>;
let fixturePath: string;

beforeEach(() => {
  fixture = setup();
  fixturePath = join(dirname(dirname(fixture.receiptStore.path)), 'document.json');
  vi.stubEnv('FLAGRADIUS_ENVIRONMENT', undefined);
  vi.stubEnv('FLAGRADIUS_SNAPSHOT_DIRECTORY', fixture.snapshotStore.directory);
  vi.stubEnv('FLAGRADIUS_FIXTURE_DOCUMENT', fixturePath);
  vi.stubEnv('FLAGRADIUS_ROSTER_PATH', undefined);
  vi.stubEnv('FLAGRADIUS_ROSTER_VERSION', undefined);
  vi.stubEnv('FLAGSMITH_API_TOKEN', undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fixture.cleanup();
});

function git(...args: string[]) {
  return execFileSync('git', args, { cwd: fixture.snapshotStore.directory, encoding: 'utf8' }).trim();
}

async function run(...args: string[]) {
  const stdout = vi.fn<(message: string) => void>();
  const stderr = vi.fn<(message: string) => void>();
  const code = await runSnapshotCli(args, undefined, { stdout, stderr });
  return { code, stdout, stderr };
}

test('captures a redacted live baseline using only the environment-document GET', async () => {
  const doc = document();
  doc.identity_overrides = [{ identifier: roster[1].identifier, environment_api_key: doc.api_key, identity_features: [state(false)] }];
  const rosterPath = join(dirname(fixturePath), 'roster.json');
  writeFileSync(rosterPath, JSON.stringify({ roster, roster_version: 'operator-v1' }));
  vi.stubEnv('FLAGRADIUS_ROSTER_PATH', rosterPath);
  vi.stubEnv('FLAGRADIUS_FIXTURE_DOCUMENT', undefined);
  vi.stubEnv('FLAGSMITH_API_URL', 'http://flagsmith.test');
  vi.stubEnv('FLAGSMITH_PROJECT_ID', String(doc.project.id));
  vi.stubEnv('FLAGSMITH_ENVIRONMENT_KEY', doc.api_key);
  vi.stubEnv('FLAGSMITH_API_TOKEN', 'fixture-only');
  const provider = vi.fn(async (url: string | URL, options: RequestInit) => {
    expect(new URL(url).pathname).toBe(`/api/v1/environments/${doc.api_key}/document/`);
    expect(options.method ?? 'GET').toBe('GET');
    expect(options.body).toBeUndefined();
    return Response.json(doc);
  });
  vi.stubGlobal('fetch', provider);

  const { code, stdout, stderr } = await run('--env', environment, '--init');

  expect(code).toBe(0);
  expect(stderr).not.toHaveBeenCalled();
  expect(stdout).toHaveBeenCalledTimes(1);
  expect(provider).toHaveBeenCalledTimes(1);
  expect(git('rev-list', '--count', 'HEAD')).toBe('1');
  const { request_id } = JSON.parse(stdout.mock.calls[0][0]);
  const metadata = { mode: 'LIVE_FLAGSMITH', request_id, environment, roster_version: 'operator-v1' };
  expect(request_id).toMatch(/^[0-9a-f-]{36}$/);
  expect(JSON.parse(stdout.mock.calls[0][0])).toEqual({ status: 'snapshotted', ...metadata, snapshot_commit: git('rev-parse', 'HEAD') });
  expect(git('show', `HEAD:environment-${environment}.json`)).not.toContain(doc.api_key);
  expect(JSON.parse(git('show', `HEAD:environment-${environment}.json`))).toMatchObject({ ...metadata, document: {
    api_key: '[REDACTED]', identity_overrides: [{ environment_api_key: '[REDACTED]' }],
  } });
});

test('replays an offline baseline and a later manual capture through diagnoseTimeline', async () => {
  const { backend, snapshotStore } = fixture;
  const roster = generateRoster();
  const baseline = document(true);
  writeFileSync(fixturePath, JSON.stringify(baseline));
  const output = execFileSync('npm', ['run', '--silent', 'snapshot', '--', '--env', environment, '--init'], { encoding: 'utf8' });
  const snapshot = JSON.parse(output);
  expect(snapshot).toMatchObject({ status: 'snapshotted', mode, environment, roster_version: 'synthetic-v1' });
  const query = { backend, environment, flag, identity: roster[0].identifier, roster,
    roster_version: 'synthetic-v1', snapshotDirectory: snapshotStore.directory };
  backend.live = baseline;
  expect(await diagnoseTimeline(query)).toMatchObject({ head_commit: snapshot.snapshot_commit, snapshots_replayed: 1,
    transitions: [], snapshot_gap: false, parity: { verdict: 'aligned' } });

  backend.live = document(false);
  writeFileSync(fixturePath, JSON.stringify(backend.live));
  const { code, stdout, stderr } = await run('--env', environment);
  expect(code).toBe(0);
  expect(stderr).not.toHaveBeenCalled();
  const manual = JSON.parse(stdout.mock.calls[0][0]);
  expect(await diagnoseTimeline(query)).toMatchObject({ head_commit: manual.snapshot_commit, snapshots_replayed: 2,
    transitions: [{ commit: manual.snapshot_commit, before: { enabled: true }, after: { enabled: false } }],
    snapshot_gap: false, parity: { verdict: 'aligned' } });
  expect(backend.writes).toEqual([]);
});

test('rejects an unconfigured environment before attempting to read the fixture', async () => {
  vi.stubEnv('FLAGRADIUS_ENVIRONMENT', 'configured-sandbox');
  const { code, stdout, stderr } = await run('--env', environment);
  expect(code).toBe(1);
  expect(stdout).not.toHaveBeenCalled();
  expect(JSON.parse(stderr.mock.calls[0][0])).toMatchObject({ mode, code: 'ENV_NOT_ALLOWED' });
  expect(existsSync(fixture.snapshotStore.directory)).toBe(false);
});

test.each(['{', JSON.stringify({ ...document(), feature_states: [{ ...state(false), enabled: 'no' }] })])('rejects an invalid fixture document', async input => {
  writeFileSync(fixturePath, input);
  const { code, stdout, stderr } = await run('--env', environment, '--init');
  expect(code).toBe(1);
  expect(stdout).not.toHaveBeenCalled();
  expect(JSON.parse(stderr.mock.calls[0][0])).toMatchObject({ mode, code: 'INVALID_DOCUMENT' });
  expect(existsSync(fixture.snapshotStore.directory)).toBe(false);
});
