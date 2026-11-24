import { expect, test } from 'vitest';
import { runDemoFromEnvironment } from '../src/demo.js';

const mode = 'LIVE_FLAGSMITH';

test.skipIf(process.env.FLAGRADIUS_LIVE_E2E !== '1')('reproduces the full storyline on Docker Flagsmith through CLI v2, stdio MCP and the HTML approval form', async () => {
  const report = await runDemoFromEnvironment();
  expect(report.act1).toMatchObject({
    mode, broadScope: 2000, blocked: { status: 'blocked', code: 'BLOCKED_INTENT_MISMATCH' },
    narrowed: { status: 'snapshotted', total_flipped: 12 }, snapshotCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
    qa: { enabled: true, value: 'qa' }, standard: { enabled: false, value: 'control' },
  });
  expect(report.act2).toMatchObject({
    mode, before: { enabled: true, value: 'control' }, broken: { enabled: false, value: 'regression' },
    diagnosis: { alignment: 'aligned', snapshotGap: false, unchanged: true,
      fixes: [{ type: 'set_identity_override', affected: 1 }, { type: 'set_segment_override', affected: 5 }],
    },
    recovery: { status: 'snapshotted', approval: 'scripted', enabled: true, value: 'control' },
    peer: { enabled: false, value: 'regression' },
  });
  expect(report.act2.diagnosis.culprit.commit).toBe(report.act2.regressionCommit);
  expect(report.approvalHtml).toContain('Apply an identity override');
  expect(report.approvalHtml).toContain('Revert the segment override');
  expect(report.stale).toMatchObject({ mode, status: 'stale_approval', writes: 0, unchanged: true });
  expect(report.crash).toMatchObject({ mode, locked: 'ENV_CRASH_LOCKED', status: 'reconciled_not_applied',
    resumed: { status: 'snapshotted', affected: 12 }, qa: { enabled: true, value: 'qa-after-reconcile' },
  });
  const statuses = (id: string) => report.writeReceipts.filter(row => row.request_id === id && row.mode === mode).map(row => row.status);
  expect(statuses(report.act1.narrowed.request_id)).toEqual(['received', 'evaluated', 'auto_approved', 'write_attempted', 'verified', 'snapshotted']);
  expect(statuses(report.act2.recovery.requestId)).toEqual(['received', 'evaluated', 'pending_approval', 'write_attempted', 'verified', 'snapshotted']);
  expect(statuses(report.stale.requestId)).toEqual(['received', 'evaluated', 'pending_approval', 'stale_approval']);
  expect(statuses(report.crash.requestId)).toEqual(['received', 'evaluated', 'pending_approval', 'write_attempted', 'reconciled_not_applied']);
  expect(report.teardown).toEqual({ mode, mcpChildren: 0, executorListeners: 0 });
}, 240_000);
