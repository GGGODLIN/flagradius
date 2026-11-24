import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createLiveEvaluationReader, runDiagnoseCli } from '../src/diagnose-cli.js';
import { FlagsmithAdapter } from '../src/flagsmith-adapter.js';
import { diagnoseTimeline } from '../src/timeline-diagnose.js';
import { document, flag, roster, rule, state } from './fixtures.js';
import { environment, mode, setup } from './guard-fixture.js';
import type { EnvironmentDocument } from '../src/types.js';

const identity = 'vip-acme-042';
const cliArgs = ['--env', environment, '--flag', flag, '--identity', identity];
const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function fixture() {
  const guard = setup({ roster, protected_flags: [flag] });
  cleanups.push(guard.cleanup);
  const { backend, snapshotStore, options } = guard;
  const sources = { backend, roster, roster_version: options.roster_version, snapshotDirectory: snapshotStore.directory };
  const query = { ...sources, environment, flag, identity };
  const capture = (doc: EnvironmentDocument, request_id: string) => snapshotStore.commitSnapshot({
    document: doc, environment, mode, request_id, roster_version: sources.roster_version,
  });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: snapshotStore.directory, encoding: 'utf8' }).trim();
  const cli = async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runDiagnoseCli(cliArgs, async () => sources, {
      stdout: message => stdout.push(message), stderr: message => stderr.push(message),
    });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  };
  return { ...guard, query, capture, git, cli };
}

function overrideDocument(override?: boolean): EnvironmentDocument {
  const doc = document(true);
  doc.project.segments.push({
    id: 7, name: 'internal_testers', rules: [rule('cohort', 'internal_testers')],
    feature_states: override === undefined ? [] : [state(override, { django_id: 207, feature_segment: { priority: 0 } })],
  });
  return doc;
}

function withIdentityKey(doc: EnvironmentDocument, environment_api_key?: string): EnvironmentDocument {
  return { ...doc, identity_overrides: [{ identifier: identity, environment_api_key, identity_features: [state(false)] }] };
}

describe('timeline diagnosis', () => {
  test('replays 37 snapshots in ancestry order and reports each non-monotonic flip', async () => {
    const { capture, query, backend } = fixture();
    const commits = Array.from({ length: 37 }, (_, i) => capture(document(i < 7 || (i >= 18 && i < 29)), `snapshot-${i}`));
    backend.live = document(false);

    const report = await diagnoseTimeline(query);
    expect(report.snapshots_replayed).toBe(37);
    expect(report.transitions.map(({ commit, request_id, before, after }) => [commit, request_id, before.enabled, after.enabled])).toEqual([
      [commits[7], 'snapshot-7', true, false],
      [commits[18], 'snapshot-18', false, true],
      [commits[29], 'snapshot-29', true, false],
    ]);
    expect(report.head_commit).toBe(commits[36]);
  }, 20_000);

  test('reports an empty window explicitly and still compares live against HEAD', async () => {
    const { capture, query, backend } = fixture();
    const head = capture(document(true), 'old-baseline');
    backend.live = document(false);
    const report = await diagnoseTimeline({ ...query, since: '1h', now: Date.now() + 2 * 60 * 60 * 1000 });
    expect(report).toMatchObject({
      head_commit: head, snapshots_replayed: 0, transitions: [], snapshot_gap: true,
      timeline_message: 'no flag-config transition found',
    });
  });

  test('ignores redacted credentials, flags genuine live drift, and repeated engine and CLI runs leave no writes or new commits', async () => {
    const { backend, capture, query, git, cli, receiptStore } = fixture();
    backend.live = withIdentityKey(document(), 'synthetic-identity-key');
    const head = capture(backend.live, 'recorded-head');
    const beforeStatus = git('status', '--porcelain');
    expect((await diagnoseTimeline(query)).snapshot_gap).toBe(false);
    backend.live = withIdentityKey(document(true));
    expect(await diagnoseTimeline(query)).toMatchObject({ mode, snapshot_gap: true, snapshot_gap_reason: 'external_drift_unrecorded' });
    for (let run = 0; run < 2; run++) {
      const result = await cli();
      expect(result).toMatchObject({ code: 0, stderr: '' });
      const report = JSON.parse(result.stdout);
      expect(report).toMatchObject({ mode, head_commit: head, snapshot_gap: true, snapshot_gap_reason: 'external_drift_unrecorded' });
      expect(result.stdout.includes('synthetic-identity-key')).toBe(false);
    }
    const fixturePath = join(query.snapshotDirectory, '..', 'current.json');
    const rosterPath = join(query.snapshotDirectory, '..', 'roster.json');
    writeFileSync(fixturePath, JSON.stringify(backend.live));
    writeFileSync(rosterPath, JSON.stringify({ roster, roster_version: query.roster_version }));
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/diagnose-cli.ts', ...cliArgs, '--since', '48h'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, FLAGRADIUS_ENVIRONMENT: environment,
        FLAGRADIUS_FIXTURE_DOCUMENT: fixturePath, FLAGRADIUS_ROSTER_PATH: rosterPath, FLAGRADIUS_SNAPSHOT_DIRECTORY: query.snapshotDirectory },
    });
    expect(JSON.parse(output)).toMatchObject({ mode, head_commit: head, snapshot_gap: true, snapshot_gap_reason: 'external_drift_unrecorded' });
    expect(git('rev-parse', 'HEAD')).toBe(head);
    expect(git('status', '--porcelain')).toBe(beforeStatus);
    expect(receiptStore.readAll()).toEqual([]);
    expect(backend.writes).toEqual([]);

    const control = await setupWriteControl();
    expect(control.backend.writes).toEqual([{ type: 'set_environment_default', flag_name: flag, enabled: true }]);
    expect(control.git('rev-parse', 'HEAD')).not.toBe(control.initialHead);
  });

  test('separates aligned evaluations, evaluation mismatches and missing inputs', async () => {
    const { backend, query, capture } = fixture();
    backend.live = overrideDocument(false);
    capture(backend.live, 'aligned');
    const live = { enabled: false, value: 'control' };
    const offline = { enabled: false, value: 'control' };
    const liveQuery = { ...query, backend: {
      mode: 'LIVE_FLAGSMITH' as const,
      fetchEnvironmentDocument: () => backend.fetchEnvironmentDocument(),
      applyOperationToDocument: backend.applyOperationToDocument.bind(backend),
    } };
    expect((await diagnoseTimeline({ ...liveQuery, readLiveEvaluation: async () => live })).parity).toEqual({ verdict: 'aligned', live, offline });
    const disagreement = { enabled: true, value: 'control' };
    expect((await diagnoseTimeline({ ...liveQuery, readLiveEvaluation: async () => disagreement })).parity).toEqual({
      verdict: 'evaluation_mismatch', live: disagreement, offline,
    });
    for (const unaligned of [{ ...liveQuery, roster: [] }, { ...liveQuery, roster: [{ ...roster[2], traits: {} }] }]) {
      expect((await diagnoseTimeline({ ...unaligned, readLiveEvaluation: async () => live })).parity.verdict).toBe('inputs_not_aligned');
    }
    const missing = overrideDocument(false);
    Reflect.deleteProperty(missing.feature_states[0], 'feature_state_value');
    capture(missing, 'missing-snapshot-field');
    const report = await diagnoseTimeline({ ...liveQuery, readLiveEvaluation: async () => live });
    expect(report.parity.verdict).toBe('inputs_not_aligned');
    expect(report.timeline_message).not.toBe('no flag-config transition found');
  });

  test('live diagnosis fetches an environment document and evaluates the roster through a transient SDK request', async () => {
    const { query, capture, backend } = fixture();
    backend.live = overrideDocument(false);
    capture(backend.live, 'before-live-diagnosis');
    const config = { apiUrl: 'http://flagsmith.test/api/v1/', projectId: 8, environmentKey: 'synthetic-env-key', apiToken: 'fixture-only' };
    const requests: Array<{ path: string; method: string; body: unknown }> = [];
    let omitTraits = false;
    vi.stubGlobal('fetch', async (url: string | URL, init: RequestInit) => {
      const path = new URL(url).pathname;
      requests.push({ path, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : null });
      if (path.endsWith('/document/')) return Response.json(backend.live);
      return Response.json({ flags: [state(false)], traits: omitTraits ? [] : [{ trait_key: 'cohort', trait_value: 'internal_testers' }] });
    });
    const liveQuery = { ...query, backend: new FlagsmithAdapter(config), readLiveEvaluation: createLiveEvaluationReader(config) };
    expect((await diagnoseTimeline(liveQuery)).parity).toEqual({
      verdict: 'aligned', live: { enabled: false, value: 'control' }, offline: { enabled: false, value: 'control' },
    });
    expect(requests).toEqual([
      { path: '/api/v1/environments/synthetic-env-key/document/', method: 'GET', body: null },
      { path: '/api/v1/identities/', method: 'POST', body: { identifier: identity, transient: true,
        traits: [{ trait_key: 'cohort', trait_value: 'internal_testers', transient: true }] } },
    ]);
    omitTraits = true;
    expect((await diagnoseTimeline(liveQuery)).parity.verdict).toBe('inputs_not_aligned');
  });

  test.each([undefined, true])('compares targeted and segment recovery through the real Approval Card (before override %s)', async before => {
    const { backend, query, capture, engine } = fixture();
    capture(overrideDocument(before), 'healthy');
    backend.live = overrideDocument(false);
    capture(backend.live, 'incident');
    const { candidates } = await diagnoseTimeline(query);
    expect(candidates.map(({ kind, proposal, blast_radius }) => [kind, proposal.operation, blast_radius.flipped_on, blast_radius.flipped_off, blast_radius.vip_hits])).toEqual([
      ['targeted', { type: 'set_identity_override', flag_name: flag, identifier: identity, enabled: true, value: 'control' }, 1, 0, 1],
      ['revert', before === undefined
        ? { type: 'delete_segment_override', flag_name: flag, segment_id: 7 }
        : { type: 'set_segment_override', flag_name: flag, segment_id: 7, enabled: true }, 2, 0, 1],
    ]);
    for (const candidate of candidates) {
      const result = await engine.proposeChange(candidate.proposal);
      expect(result).toMatchObject({ status: 'pending_approval', card: { blast_radius: candidate.blast_radius } });
    }
    expect(backend.writes).toEqual([]);
  });

  test('preserves an unrelated live value edit and omits deletion of an override edited after the incident', async () => {
    for (const before of [undefined, true]) {
      const { backend, query, capture } = fixture();
      const healthy = overrideDocument(before);
      healthy.feature_states[0].feature_state_value = 'newer';
      if (before !== undefined) healthy.project.segments[0].feature_states[0].feature_state_value = 'newer';
      capture(healthy, 'healthy');
      capture(overrideDocument(false), 'incident');
      backend.live = overrideDocument(false);
      backend.live.project.segments[0].feature_states[0].feature_state_value = 'external';
      const report = await diagnoseTimeline(query);
      expect(report.snapshot_gap).toBe(true);
      expect(report.candidates.find(candidate => candidate.kind === 'revert')).toBeUndefined();
    }

    const { backend, query, capture } = fixture();
    capture(overrideDocument(true), 'healthy');
    capture(overrideDocument(false), 'incident');
    backend.live = overrideDocument(false);
    backend.live.project.segments[0].feature_states[0].feature_state_value = 'external';
    const { candidates } = await diagnoseTimeline(query);
    expect(candidates.find(candidate => candidate.kind === 'targeted')?.proposal.operation).toEqual({
      type: 'set_identity_override', flag_name: flag, identifier: identity, enabled: true, value: 'external',
    });
    expect(candidates.find(candidate => candidate.kind === 'revert')?.proposal.operation).toEqual({
      type: 'set_segment_override', flag_name: flag, segment_id: 7, enabled: true,
    });
  });

  test('fails with a structured error for missing repositories and malformed committed snapshots', async () => {
    const { backend, query, capture, git, cli, snapshotStore } = fixture();
    await expect(diagnoseTimeline(query)).rejects.toMatchObject({ mode, code: 'SNAPSHOT_REPOSITORY_UNAVAILABLE' });
    capture(backend.live, 'before-corruption');
    await expect(diagnoseTimeline({ ...query, snapshotDirectory: join(snapshotStore.directory, '..') })).rejects.toMatchObject({
      mode, code: 'SNAPSHOT_REPOSITORY_UNAVAILABLE',
    });
    const file = `environment-${encodeURIComponent(environment)}.json`;
    writeFileSync(join(snapshotStore.directory, file), '{broken json');
    git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'malformed snapshot', '--', file);
    await expect(diagnoseTimeline(query)).rejects.toMatchObject({ mode, code: 'CORRUPT_SNAPSHOT' });
    const result = await cli();
    expect(result).toMatchObject({ code: 1, stdout: '' });
    expect(JSON.parse(result.stderr)).toMatchObject({ mode, code: 'CORRUPT_SNAPSHOT' });
  });
});

async function setupWriteControl() {
  const guard = setup();
  cleanups.push(guard.cleanup);
  const initialHead = guard.snapshotStore.commitSnapshot({
    mode, environment, request_id: 'baseline', roster_version: guard.options.roster_version, document: guard.backend.live,
  });
  const result = await guard.engine.proposeChange({
    environment, declared_intent: 'all', operation: { type: 'set_environment_default', flag_name: flag, enabled: true },
  });
  expect(result.status).toBe('snapshotted');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: guard.snapshotStore.directory, encoding: 'utf8' }).trim();
  return { ...guard, git, initialHead };
}
