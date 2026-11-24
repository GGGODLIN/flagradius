import { execFileSync } from 'node:child_process';
import { expect, test } from 'vitest';
import { runUnifiedDemo } from '../src/demo.js';
import { createFlagEvaluator } from '../src/evaluator.js';
import { generateRoster } from '../src/roster.js';
import { document, rule } from './fixtures.js';
import { setup } from './guard-fixture.js';
import type { FlagWriteOperation } from '../src/types.js';

const roster = generateRoster();
const mode = 'OFFLINE_FIXTURE_REPLAY';
const flag = 'new_search';

function sandbox() {
  const fixture = setup();
  fixture.backend.live = document();
  fixture.backend.live.project.segments = [
    { id: 10, name: 'internal_testers', rules: [rule('cohort', 'internal_testers')], feature_states: [] },
    { id: 11, name: 'vip', rules: [rule('cohort', 'vip')], feature_states: [] },
  ];
  const run = () => runUnifiedDemo({
    backend: fixture.backend,
    stateDirectory: fixture.snapshotStore.directory + '/..',
    qaSegmentId: 10,
    vipSegmentId: 11,
    approval: 'scripted',
    readBack: fixture.backend.fetchEnvironmentDocument.bind(fixture.backend),
    readLiveEvaluation: async (identity, name) => createFlagEvaluator(fixture.backend.live, name)(identity),
    editOutOfBand: async (operation: FlagWriteOperation) => {
      fixture.backend.live = fixture.backend.applyOperationToDocument(fixture.backend.live, operation);
    },
  });
  return { ...fixture, run };
}

test('blocks the broad QA request and snapshots the 12-person rollout through the guard', async () => {
  const { run, cleanup, receiptStore, snapshotStore } = sandbox();
  try {
    const report = await run();
    expect(report?.act1).toMatchObject({
      mode, blocked: { code: 'BLOCKED_INTENT_MISMATCH', request_id: expect.any(String) },
      broadScope: 2000, narrowed: { total_flipped: 12, status: 'snapshotted' },
      qa: { enabled: true, value: 'qa' }, standard: { enabled: false, value: 'control' },
    });
    const request = report!.act1.narrowed;
    expect(receiptStore.readAll().filter(row => row.request_id === request.request_id).map(row => row.status))
      .toEqual(['received', 'evaluated', 'auto_approved', 'write_attempted', 'verified', 'snapshotted']);
    const onDisk = JSON.parse(execFileSync('git', ['show', `${report.act1.snapshotCommit}:environment-prod.json`],
      { cwd: snapshotStore.directory, encoding: 'utf8' }));
    expect(createFlagEvaluator(onDisk.document, flag)(roster.find(user => user.identifier === 'qa-12')!))
      .toEqual({ enabled: true, value: 'qa' });
  } finally { cleanup(); }
});

test('replays the VIP regression read-only, compares both fixes in the card, and approves through the form', async () => {
  const { run, cleanup, backend } = sandbox();
  try {
    const report = await run();
    expect(report?.act2).toMatchObject({
      mode, before: { enabled: true, value: 'control' }, broken: { enabled: false, value: 'regression' },
      diagnosis: { snapshotsReplayed: 3, alignment: 'aligned', snapshotGap: false, unchanged: true,
        culprit: { segmentId: 11, commit: expect.any(String) },
        fixes: [{ type: 'set_identity_override', affected: 1 }, { type: 'set_segment_override', affected: 5 }],
      },
      recovery: { status: 'snapshotted', approval: 'scripted', value: 'control', enabled: true },
      peer: { enabled: false, value: 'regression' },
    });
    expect(report!.approvalHtml).toContain('Apply an identity override');
    expect(report!.approvalHtml).toContain('Revert the segment override');
    expect(report!.approvalHtml).toContain('Comparison');
    expect(report!.approvalHtml).not.toMatch(/name="token" value="[a-f0-9]{64}"/);
    expect(backend.writes.filter(op => op.type === 'set_identity_override')).toEqual([
      { type: 'set_identity_override', flag_name: flag, identifier: 'vip-acme-042', enabled: true, value: 'control' },
    ]);
  } finally { cleanup(); }
});

test('refuses a stale approval after an external edit with no executor write', async () => {
  const { run, cleanup, backend, receiptStore } = sandbox();
  try {
    const report = await run();
    expect(report?.stale).toMatchObject({ mode, status: 'stale_approval', writes: 0, unchanged: true });
    expect(receiptStore.readAll().filter(row => row.request_id === report!.stale.requestId).map(row => row.status))
      .toEqual(['received', 'evaluated', 'pending_approval', 'stale_approval']);
    expect(backend.writes.some(op => op.type === 'set_environment_default')).toBe(false);
  } finally { cleanup(); }
});

test('reconciles a durable write attempt, resumes writes and closes the local services', async () => {
  const { run, cleanup, receiptStore } = sandbox();
  try {
    const report = await run();
    expect(report?.crash).toMatchObject({ mode, locked: 'ENV_CRASH_LOCKED', status: 'reconciled_not_applied',
      resumed: { status: 'snapshotted', affected: 12 }, qa: { value: 'qa-after-reconcile', enabled: true },
    });
    expect(receiptStore.readAll().filter(row => row.request_id === report!.crash.requestId).slice(-2).map(row => row.status))
      .toEqual(['write_attempted', 'reconciled_not_applied']);
    expect(report?.teardown).toEqual({ mode, mcpChildren: 0, executorListeners: 0 });
  } finally { cleanup(); }
});
