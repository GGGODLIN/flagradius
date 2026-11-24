import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlagEvaluator, evaluateTargetedBlastRadius } from '../src/evaluator.js';
import { GuardEngine } from '../src/guard-engine.js';
import type { GuardEngineOptions } from '../src/guard-engine.js';
import type { ReceiptStore } from '../src/receipt-store.js';
import { flag, roster, rule, state } from './fixtures.js';
import { environment, mode, setup as createFixture } from './guard-fixture.js';

const cleanups: (() => void)[] = [];

function setup(overrides: Partial<GuardEngineOptions> = {}) {
  const fixture = createFixture(overrides);
  cleanups.push(fixture.cleanup);
  return fixture;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const operation = { type: 'set_environment_default', flag_name: flag, enabled: true } as const;
const proposal = { environment, declared_intent: 'all', operation };
const qa = (id: number, name: string) => ({ id, name, rules: [rule('cohort', 'internal_testers')], feature_states: [] });
const scoped = { environment, declared_intent: 'QA', operation: { ...operation, type: 'set_segment_override', segment_id: 9 } };

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' });
}

function assertRequest(result: { request_id: string; mode: string }, receiptStore: ReceiptStore) {
  expect(result).toMatchObject({ mode, request_id: expect.any(String) });
  const receipts = receiptStore.readAll().filter(receipt => receipt.request_id === result.request_id);
  expect(receipts[0]).toMatchObject({ status: 'received', mode, request_id: result.request_id });
  expect(receipts.every(receipt => receipt.mode === mode)).toBe(true);
  return receipts.map(receipt => receipt.status);
}

function expectSortedKeys(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) expect(Object.keys(value)).toEqual(Object.keys(value).sort());
  for (const child of Object.values(value)) expectSortedKeys(child);
}

describe('GuardEngine pre-write policy', () => {
  it('enforces the allowlist before project scope, and project scope before reading or writing', async () => {
    const { engine, backend, receiptStore } = setup();
    const crossEnv = { ...proposal, operation: { type: 'create_segment_rule' } };
    expect(await engine.proposeChange({ ...crossEnv, environment: 'other' })).toMatchObject({ code: 'ENV_NOT_ALLOWED' });
    for (const type of ['create_segment_rule', 'update_segment_rule', 'delete_segment_rule']) {
      const result = await engine.proposeChange({ ...crossEnv, operation: { type } });
      expect(result).toMatchObject({ status: 'blocked', code: 'CROSS_ENV_LOCKED' });
      expect(assertRequest(result, receiptStore)).toEqual(['received', 'blocked']);
    }
    expect(backend.writes).toEqual([]);
    expect(backend.reads).toBe(0);
    expect((await engine.proposeChange(proposal)).status).toBe('snapshotted');
    expect(backend.writes).toEqual([operation]);
  });

  it.each([
    [[], 'BLOCKED_INTENT_MISMATCH'],
    [[qa(9, 'internal_testers')], 'BLOCKED_INTENT_MISMATCH'],
    [[qa(9, 'internal_testers'), qa(10, 'QA')], 'NEEDS_DISAMBIGUATION'],
  ] as const)('preserves the default for QA with candidates %j', async (segments, code) => {
    const { engine, backend, receiptStore } = setup();
    backend.live.project.segments = [...segments];
    const result = await engine.proposeChange({ ...proposal, declared_intent: 'QA' });
    expect(result).toMatchObject({ code, candidates: segments.map(({ id, name }) => ({ segment_id: id, name })) });
    if (segments.length === 1) {
      expect(result).toMatchObject({ suggested_action: { type: 'set_segment_override', segment_id: 9, name: 'internal_testers' } });
    } else {
      expect(result).not.toHaveProperty('suggested_action');
    }
    expect(assertRequest(result, receiptStore)).toEqual(['received', code === 'NEEDS_DISAMBIGUATION' ? 'needs_disambiguation' : 'blocked']);
    expect(backend.live.feature_states[0].enabled).toBe(false);
    expect(backend.writes).toEqual([]);
    if (segments.length > 0) {
      expect(await engine.proposeChange(scoped)).toMatchObject({ status: 'snapshotted', blast_radius: { total_flipped: 1 } });
      expect(backend.writes).toEqual([scoped.operation]);
      expect(backend.live.feature_states[0].enabled).toBe(false);
    }
  });

  it('suggests the unique QA segment and blocks a write to the wrong segment', async () => {
    const { engine, backend } = setup();
    backend.live.project.segments = [qa(9, 'internal_testers'), {
      id: 10, name: 'general_access', rules: [rule('cohort', 'standard')], feature_states: [],
    }];

    const result = await engine.proposeChange({ ...scoped, operation: { ...scoped.operation, segment_id: 10 } });

    expect(result).toMatchObject({
      status: 'blocked', code: 'BLOCKED_INTENT_MISMATCH',
      candidates: [{ segment_id: 9, name: 'internal_testers' }],
      suggested_action: { type: 'set_segment_override', segment_id: 9, name: 'internal_testers' },
    });
    expect(backend.writes).toEqual([]);
  });

  it('rejects fields that attempt to give an environment default a narrower scope', async () => {
    const { engine, backend } = setup();
    backend.live.project.segments = [qa(9, 'internal_testers')];
    for (const extra of [{ identifier: 'QA' }, { segment_id: 9 }]) {
      const result = await engine.proposeChange({ ...proposal, declared_intent: 'QA', operation: { ...operation, ...extra } });
      expect(result).toMatchObject({ status: 'blocked', code: 'INVALID_PROPOSAL' });
    }
    expect(backend.live.feature_states[0].enabled).toBe(false);
    expect(backend.writes).toEqual([]);
    expect(await engine.proposeChange(scoped)).toMatchObject({ status: 'snapshotted' });
    expect(backend.writes).toEqual([scoped.operation]);
  });

  it.each([0, 20])('auto-writes at the inclusive default limit with %i identities and commits normalized read-back', async (count) => {
    const { engine, backend, receiptStore, snapshotStore } = setup({
      roster: Array.from({ length: count }, (_, i) => ({ identifier: `qa-${i}`, traits: { cohort: 'internal_testers' }, vip: false })),
    });
    backend.live.project.segments = [qa(9, 'internal_testers')];
    const result = await engine.proposeChange(scoped);
    expect(result).toMatchObject({ status: 'snapshotted', blast_radius: { total_evaluated: count, flipped_on: count, total_flipped: count, vip_hits: 0 } });
    expect(assertRequest(result, receiptStore)).toEqual(['received', 'evaluated', 'auto_approved', 'write_attempted', 'verified', 'snapshotted']);
    expect(backend.writes).toEqual([scoped.operation]);
    expect(backend.reads).toBe(3);
    const file = git(snapshotStore.directory, 'ls-tree', '--name-only', 'HEAD').trim();
    const snapshot = JSON.parse(git(snapshotStore.directory, 'show', `HEAD:${file}`));
    expect(git(snapshotStore.directory, 'rev-list', '--count', 'HEAD').trim()).toBe('1');
    expect(snapshot).toMatchObject({ environment, mode, request_id: result.request_id, roster_version: 'fixture-v1', document: { ...backend.live, api_key: '[REDACTED]' } });
    expectSortedKeys(snapshot);
  });

  it.each([
    ['OVER_BUDGET', { max_single_auto_flips: 1 }, { ...proposal, operation: { type: 'set_environment_default', flag_name: flag, value: 'variant' } }, { value_changed: 2 }],
    ['VIP_IMPACT', { roster }, proposal, { vip_hits: 1 }],
    ['PROTECTED_FLAG', { protected_flags: [flag] }, { ...proposal, operation: { ...operation, enabled: false } }, { total_flipped: 0 }],
  ] as const)('requires one-time approval for %s, even with value-only or zero-flip changes', async (reason, overrides, input, impact) => {
    const { engine, backend, receiptStore, options } = setup(overrides);
    const result = await engine.proposeChange(input);
    expect(result).toMatchObject({ status: 'pending_approval', card: { status: 'pending', mode, request_id: result.request_id,
      id: expect.any(String), target_baseline_state: { enabled: false }, reasons: [reason], blast_radius: impact } });
    expect(assertRequest(result, receiptStore)).toEqual(['received', 'evaluated', 'pending_approval']);
    expect(backend.writes).toEqual([]);
    if (result.status !== 'pending_approval') throw new Error('Expected an approval card');
    const restarted = new GuardEngine(options);
    expect(await restarted.approveCard(result.card.id)).toMatchObject({ status: 'snapshotted', request_id: result.request_id });
    expect(await restarted.approveCard(result.card.id)).toMatchObject({ status: 'already_approved', request_id: result.request_id });
    expect(backend.writes).toEqual([input.operation]);
  });

  it('requires approval for an unknown identity with zero modeled flips or automatic writes', async () => {
    const { backend, engine, receiptStore } = setup();
    const identifier = 'synthetic-unmodeled-identity';
    const result = await engine.proposeChange({ environment, declared_intent: identifier,
      operation: { ...operation, type: 'set_identity_override', identifier },
    });
    expect(result).toMatchObject({ status: 'pending_approval', card: { reasons: ['UNKNOWN_IDENTITY'], blast_radius: { total_flipped: 0 } } });
    expect(assertRequest(result, receiptStore)).toEqual(['received', 'evaluated', 'pending_approval']);
    expect(backend.writes).toHaveLength(0);
  });

  it('rejects approval after segment drift changes who flips while counts stay identical', async () => {
    const { backend, engine, options, receiptStore } = setup({ max_single_auto_flips: 0 });
    backend.live.project.segments = [qa(9, 'internal_testers')];
    const pending = await engine.proposeChange(scoped);
    if (pending.status !== 'pending_approval') throw new Error('Expected a pending card');
    expect(pending.blast_radius).toEqual({ total_evaluated: 2, total_flipped: 1, flipped_on: 1, flipped_off: 0, value_changed: 0, vip_hits: 0 });
    const preview = () => backend.applyOperationToDocument(backend.live, { ...operation, type: 'set_segment_override', segment_id: 9 });
    const enabled = () => options.roster.map(createFlagEvaluator(preview(), flag)).map(result => result.enabled);
    expect(enabled()).toEqual([false, true]);
    backend.live.project.segments[0].rules = [rule('cohort', 'standard')];
    expect(enabled()).toEqual([true, false]);
    expect(evaluateTargetedBlastRadius(backend.live, preview(), flag, options.roster)).toEqual(pending.blast_radius);
    expect(await engine.approveCard(pending.card.id)).toMatchObject({ status: 'stale_approval', request_id: pending.request_id });
    expect(assertRequest(pending, receiptStore)).toEqual(['received', 'evaluated', 'pending_approval', 'stale_approval']);
    expect(backend.writes).toHaveLength(0);
  });

  it('reads legacy receipts but treats a pending card without impact proof as stale', async () => {
    const { backend, engine, options, receiptStore } = setup({ max_single_auto_flips: 0 });
    const pending = await engine.proposeChange(proposal);
    if (pending.status !== 'pending_approval') throw new Error('Expected a pending card');
    const legacy = receiptStore.readAll().map(receipt => {
      if (receipt.status !== 'pending_approval') return receipt;
      const { affected_identities_digest: _digest, baseline_revision: _revision, ...plan } = receipt.plan;
      return { ...receipt, plan };
    });
    fs.writeFileSync(receiptStore.path, legacy.map(receipt => JSON.stringify(receipt)).join('\n') + '\n');
    const restarted = new GuardEngine(options);
    expect(await restarted.approveCard(pending.card.id)).toMatchObject({ status: 'stale_approval' });
    expect(backend.writes).toHaveLength(0);
    expect(await restarted.proposeChange(proposal)).toMatchObject({ status: 'pending_approval' });
  });

  it('refuses approval after the environment alias has moved to another provider environment', async () => {
    const { backend, engine, options } = setup({ max_single_auto_flips: 0 });
    const pending = await engine.proposeChange(proposal);
    if (pending.status !== 'pending_approval') throw new Error('Expected a pending card');
    backend.live.id = 2;
    const restarted = new GuardEngine(options);
    expect(await restarted.approveCard(pending.card.id)).toMatchObject({ status: 'stale_approval' });
    expect(backend.writes).toEqual([]);
    const fresh = await restarted.proposeChange(proposal);
    if (fresh.status !== 'pending_approval') throw new Error('Expected a fresh card');
    expect(await restarted.approveCard(fresh.card.id)).toMatchObject({ status: 'snapshotted' });
    expect(backend.writes).toEqual([operation]);
  });

  it('uses live baseline freshness in the automatic and human paths', async () => {
    const automatic = setup();
    automatic.backend.beforeRead = read => { if (read === 2) automatic.backend.live.feature_states = [state(false, { feature_state_value: 'drift' })]; };
    const result = await automatic.engine.proposeChange(proposal);
    expect(result).toMatchObject({ status: 'stale_approval' });
    expect(assertRequest(result, automatic.receiptStore)).toEqual(['received', 'evaluated', 'auto_approved', 'stale_approval']);
    expect(automatic.backend.writes).toEqual([]);

    const human = setup({ max_single_auto_flips: 0 });
    const pending = await human.engine.proposeChange(proposal);
    expect(pending).toMatchObject({ status: 'pending_approval' });
    if (pending.status !== 'pending_approval') throw new Error('Expected an approval card');
    human.backend.live.feature_states = [state(true)];
    expect(await human.engine.approveCard(pending.card.id)).toMatchObject({ status: 'stale_approval', request_id: pending.request_id });
    human.backend.live.feature_states = [state(false)];
    expect(await human.engine.approveCard(pending.card.id)).toMatchObject({ status: 'stale_approval' });
    expect(human.backend.writes).toEqual([]);
    expect(await human.engine.rejectCard(pending.card.id)).toMatchObject({ status: 'stale_approval' });
    const fresh = await human.engine.proposeChange(proposal);
    if (fresh.status !== 'pending_approval') throw new Error('Expected a fresh approval card');
    expect(await human.engine.rejectCard(fresh.card.id)).toMatchObject({ status: 'rejected', request_id: fresh.request_id });
    expect(await human.engine.approveCard(fresh.card.id)).toMatchObject({ status: 'rejected' });
    expect(human.backend.writes).toEqual([]);
    expect(await automatic.engine.proposeChange(proposal)).toMatchObject({ status: 'snapshotted' });
    expect(automatic.backend.writes).toEqual([operation]);
  });
});

describe('GuardEngine durability and input validation', () => {
  it.each([true, false])('fsyncs before execution and reconciles a restarted uncertain write (applied=%s)', async (applied) => {
    const { engine, backend, receiptStore, options } = setup();
    const actualFsync = fs.fsyncSync;
    let fsynced = false;
    vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      actualFsync(fd);
      if (receiptStore.readAll().at(-1)?.status === 'write_attempted') fsynced = true;
    });
    backend.onExecute = op => {
      expect(fsynced).toBe(true);
      expect(receiptStore.readAll().at(-1)).toMatchObject({ status: 'write_attempted', environment, mode, request_id: expect.any(String) });
      if (applied) backend.live = backend.applyOperationToDocument(backend.live, op);
      throw new Error('Simulated process interruption');
    };
    const result = await engine.proposeChange(proposal);
    expect(result).toMatchObject({ status: 'write_unconfirmed', request_id: expect.any(String) });
    expect(fsynced).toBe(true);
    expect(backend.writes).toEqual([operation]);
    const restarted = new GuardEngine(options);
    expect(await restarted.proposeChange(proposal)).toMatchObject({ status: 'blocked', code: 'ENV_CRASH_LOCKED' });
    expect(backend.writes).toEqual([operation]);
    const expected = applied ? 'reconciled_applied' : 'reconciled_not_applied';
    expect(await restarted.reconcileEnvironment(environment)).toMatchObject({ status: expected, request_id: result.request_id, mode });
    expect(assertRequest(result, receiptStore)).toEqual(['received', 'evaluated', 'auto_approved', 'write_attempted', 'write_unconfirmed', expected]);
    backend.onExecute = undefined;
    expect(await restarted.proposeChange(proposal)).toMatchObject({ status: 'snapshotted' });
    expect(backend.writes).toEqual([operation, operation]);
  });

  it('keeps a verified write crash-locked after an external revert to the original baseline', async () => {
    const { engine, backend, receiptStore, snapshotStore, options } = setup();
    const baseline = structuredClone(backend.live);
    vi.spyOn(snapshotStore, 'commitSnapshot').mockImplementationOnce(() => { throw new Error('Simulated snapshot interruption'); });
    await expect(engine.proposeChange(proposal)).rejects.toThrow('Simulated snapshot interruption');
    const verified = receiptStore.readAll().at(-1)!;
    expect(verified.status).toBe('verified');
    expect(backend.live.feature_states[0].enabled).toBe(true);
    backend.live = baseline;

    const restarted = new GuardEngine(options);
    const legacyTerminal = { ...verified, status: 'reconciled_not_applied' } as const;
    expect(() => receiptStore.append(legacyTerminal, 'verified')).toThrow('Invalid receipt transition');
    expect(await restarted.reconcileEnvironment(environment)).toMatchObject({
      status: 'write_unconfirmed', code: 'VERIFIED_DRIFT_MISMATCH', request_id: verified.request_id,
    });
    expect(assertRequest(verified, receiptStore)).toEqual(['received', 'evaluated', 'auto_approved', 'write_attempted', 'verified']);
    expect(await restarted.proposeChange(proposal)).toMatchObject({ status: 'blocked', code: 'ENV_CRASH_LOCKED' });
    expect(backend.writes).toEqual([operation]);

    fs.appendFileSync(receiptStore.path, `${JSON.stringify(legacyTerminal)}\n`);
    expect(receiptStore.readAll().filter(receipt => receipt.request_id === verified.request_id).at(-1)?.status).toBe('reconciled_not_applied');
  });

  it('keeps an attempted receipt locked on restart, and does not snapshot a mismatching read-back', async () => {
    const { engine, backend, receiptStore, options, snapshotStore } = setup();
    let release!: () => void;
    let entered!: () => void;
    const executing = new Promise<void>(resolve => { entered = resolve; });
    const hold = new Promise<void>(resolve => { release = resolve; });
    backend.onExecute = async () => { entered(); await hold; };
    const inflight = engine.proposeChange(proposal);
    try {
      await Promise.race([executing, inflight.then(() => { throw new Error('The backend was not invoked'); })]);
      expect(receiptStore.readAll().at(-1)?.status).toBe('write_attempted');
      expect(await new GuardEngine(options).proposeChange(proposal)).toMatchObject({ code: 'ENV_CRASH_LOCKED' });
    } finally {
      release();
    }
    const unconfirmed = await inflight;
    expect(unconfirmed).toMatchObject({ status: 'write_unconfirmed', code: 'READBACK_MISMATCH' });
    expect(fs.existsSync(snapshotStore.directory)).toBe(false);
    expect(await engine.reconcileEnvironment(environment)).toMatchObject({ status: 'reconciled_not_applied' });
    expect(backend.writes).toEqual([operation]);
  });

  it('validates malformed proposals without reading/writing, then fails explicitly on JSONL corruption', async () => {
    const { engine, backend, receiptStore } = setup();
    for (const input of [null, { environment }, { ...proposal, declared_intent: 42 },
      { ...scoped, operation: { ...scoped.operation, segment_id: 9.5 } },
      { ...scoped, operation: { type: 'delete_segment_override', flag_name: flag } },
      { ...proposal, operation: { ...operation, enabled: 'false' } },
      { ...proposal, operation: { flag_name: flag, type: 'set_multivariate_weights', weights: null } }]) {
      expect(await engine.proposeChange(input)).toMatchObject({ code: 'INVALID_PROPOSAL', mode, status: 'blocked', request_id: expect.any(String) });
    }
    expect(backend.reads).toBe(0);
    expect(backend.writes).toEqual([]);
    const missingId = setup();
    delete (missingId.backend.live as { id?: number }).id;
    expect(await missingId.engine.proposeChange(proposal)).toMatchObject({ status: 'blocked', code: 'INVALID_DOCUMENT', mode });
    expect(missingId.receiptStore.readAll().map(r => r.status)).toEqual(['received', 'blocked']);
    expect(await engine.proposeChange(proposal)).toMatchObject({ status: 'snapshotted' });
    const validHistory = fs.readFileSync(receiptStore.path, 'utf8');
    for (const corruptLine of ['{not-json}\n', '{}\n', '{"status":"write_attempted"}\n']) {
      fs.writeFileSync(receiptStore.path, validHistory + corruptLine);
      await expect(engine.proposeChange(proposal)).rejects.toThrow(/receipt history.*line/i);
    }
    expect(backend.writes).toEqual([operation]);
  });

  it('releases the environment mutex after a thrown read and serializes concurrent approval clicks', async () => {
    const { engine, backend, receiptStore } = setup({ max_single_auto_flips: 0 });
    backend.beforeRead = read => { if (read === 1) throw new Error('Read unavailable'); };
    await expect(engine.proposeChange(proposal)).rejects.toThrow('Read unavailable');
    expect(receiptStore.readAll().at(-1)).toMatchObject({ status: 'blocked', code: 'BASELINE_UNAVAILABLE' });
    const pending = await engine.proposeChange(proposal);
    expect(pending).toMatchObject({ status: 'pending_approval' });
    if (pending.status !== 'pending_approval') throw new Error('Expected a pending card');
    const results = await Promise.all([engine.approveCard(pending.card.id), engine.approveCard(pending.card.id)]);
    expect(results.map(result => result.status)).toEqual(['snapshotted', 'already_approved']);
    expect(backend.writes).toEqual([operation]);
  });
});

describe('bounded receipt lifecycle tour', () => {
  it('reaches every specified terminal exit and keeps the other environment independent', async () => {
    const { engine, backend, receiptStore, options } = setup();
    const other = setup();
    const shared = new GuardEngine({ ...options, environments: { ...options.environments, other: other.backend } });
    const walked = new Set<string>();
    const observe = (requestId: string, expected: string[]) => {
      const statuses = receiptStore.readAll().filter(row => row.request_id === requestId).map(row => row.status);
      expect(statuses).toEqual(expected);
      for (const status of statuses) walked.add(status);
    };
    backend.live.project.segments = [qa(9, 'internal_testers'), qa(10, 'QA')];
    const mismatch = await engine.proposeChange({ ...proposal, declared_intent: 'unmatched' });
    observe(mismatch.request_id, ['received', 'blocked']);
    const ambiguous = await engine.proposeChange({ ...proposal, declared_intent: 'QA' });
    observe(ambiguous.request_id, ['received', 'needs_disambiguation']);
    const success = await engine.proposeChange(proposal);
    observe(success.request_id, ['received', 'evaluated', 'auto_approved', 'write_attempted', 'verified', 'snapshotted']);

    const protectedEngine = new GuardEngine({ ...options, protected_flags: [flag] });
    const first = await protectedEngine.proposeChange(proposal);
    const second = await protectedEngine.proposeChange(proposal);
    if (first.status !== 'pending_approval' || second.status !== 'pending_approval') throw new Error('Expected two cards');
    await protectedEngine.rejectCard(first.card.id);
    observe(first.request_id, ['received', 'evaluated', 'pending_approval', 'rejected']);
    backend.live.feature_states = [state(false)];
    await protectedEngine.approveCard(second.card.id);
    observe(second.request_id, ['received', 'evaluated', 'pending_approval', 'stale_approval']);

    for (const applied of [true, false]) {
      backend.live.feature_states = [state(false)];
      backend.onExecute = op => {
        if (applied) backend.live = backend.applyOperationToDocument(backend.live, op);
        throw new Error('Unconfirmed write');
      };
      const crash = await shared.proposeChange(proposal);
      const independent = await shared.proposeChange({ ...proposal, environment: 'other' });
      expect(independent).toMatchObject({ environment: 'other', status: 'snapshotted' });
      backend.live.feature_states = [state(applied, { feature_state_value: 'third-state' })];
      expect(await shared.reconcileEnvironment(environment)).toMatchObject({ status: 'write_unconfirmed', code: 'RECONCILIATION_MISMATCH' });
      expect(await shared.proposeChange(proposal)).toMatchObject({ code: 'ENV_CRASH_LOCKED' });
      backend.live.feature_states = [state(applied)];
      const reconciled = await shared.reconcileEnvironment(environment);
      const expected = applied ? 'reconciled_applied' : 'reconciled_not_applied';
      expect(reconciled).toMatchObject({ status: expected, request_id: crash.request_id });
      observe(crash.request_id, ['received', 'evaluated', 'auto_approved', 'write_attempted', 'write_unconfirmed', expected]);
    }
    expect(backend.writes).toEqual([operation, operation, operation]);
    expect(other.backend.writes).toEqual([operation, operation]);
    expect([...walked].sort()).toEqual([
      'auto_approved', 'blocked', 'evaluated', 'needs_disambiguation', 'pending_approval', 'received', 'reconciled_applied',
      'reconciled_not_applied', 'rejected', 'snapshotted', 'stale_approval', 'verified', 'write_attempted', 'write_unconfirmed',
    ]);
  });
});
