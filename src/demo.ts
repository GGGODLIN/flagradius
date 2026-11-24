import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { ApprovalComparison } from './approval-ui.js';
import { createLiveEvaluationReader } from './diagnose-cli.js';
import { createFlagEvaluator, evaluateTargetedBlastRadius } from './evaluator.js';
import { startExecutorDaemon } from './executor-daemon.js';
import { FlagsmithAdapter } from './flagsmith-adapter.js';
import type { FlagsmithAdapterOptions } from './flagsmith-adapter.js';
import { GuardEngine } from './guard-engine.js';
import type { FlagsmithBackend, GuardProposal } from './guard-engine.js';
import { ReceiptStore } from './receipt-store.js';
import type { Receipt } from './receipt-store.js';
import { generateRoster } from './roster.js';
import { SnapshotStore } from './snapshot-store.js';
import { diagnoseTimeline } from './timeline-diagnose.js';
import type { DiagnoseTimelineOptions, DiagnosisReport } from './timeline-diagnose.js';
import type { EnvironmentDocument, ModeTag } from './types.js';

const environment = 'prod';
const flag = 'new_search';
const vip = 'vip-acme-042';
const roster = generateRoster();
const roster_version = 'synthetic-v1';
const liveMode = 'LIVE_FLAGSMITH';

type DefaultEdit = Extract<GuardProposal['operation'], { type: 'set_environment_default' }>;
interface DemoOptions {
  backend: FlagsmithBackend;
  readBack: () => Promise<EnvironmentDocument>;
  readLiveEvaluation: NonNullable<DiagnoseTimelineOptions['readLiveEvaluation']>;
  editOutOfBand: (operation: DefaultEdit) => Promise<void>;
  stateDirectory: string;
  qaSegmentId: number;
  vipSegmentId: number;
  approval: 'scripted' | 'human';
  signal?: AbortSignal;
  emit?: (evidence: { mode: ModeTag; stage: string }) => void;
}

interface ToolResult {
  mode: ModeTag;
  request_id: string;
  status: string;
  code?: string;
  total_flipped: number;
  total_evaluated: number;
  vip_hits: number;
  flags?: { name: string; enabled: boolean }[];
  suggested_action?: { segment_id: number; name: string };
  candidate_fixes?: { type: string; blast_radius: { total_flipped: number } }[];
  approval_url?: string;
}

const git = (snapshotStore: SnapshotStore, ...args: string[]) => execFileSync('git', args, {
  cwd: snapshotStore.directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
}).trim();

async function askForApproval(url: string, token: string) {
  const tty = await open('/dev/tty', 'w').catch(() => {
    throw new Error('Human approval requires a terminal. Use make test-live-e2e for scripted verification.');
  });
  try {
    await tty.writeFile(`\nOpen ${url} in your browser. Enter this one-run operator token and review the comparison before clicking Approve.\n${token}\n\n`);
  } finally {
    await tty.close();
  }
}

function pidAlive(pid: number | null) {
  if (pid === null) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

export async function runUnifiedDemo(options: DemoOptions) {
  const { backend, qaSegmentId, vipSegmentId, signal } = options;
  const { mode } = backend;
  const publish = (stage: string, payload: Record<string, unknown>) => options.emit?.({ ...payload, mode, stage });
  const receiptStore = new ReceiptStore(join(options.stateDirectory, 'receipts.jsonl'));
  const snapshotStore = new SnapshotStore(join(options.stateDirectory, 'snapshots'));
  const environments = { [environment]: backend };
  const engine = new GuardEngine({ environments, receiptStore, snapshotStore, roster, roster_version });
  const proposalToken = randomBytes(32).toString('hex');
  const humanApprovalToken = randomBytes(32).toString('hex');
  const history = (id: string) => receiptStore.readAll().filter(receipt => receipt.request_id === id);
  const snapshotFor = (id: string) => {
    const last = history(id).at(-1);
    assert(last?.status === 'snapshotted', 'Guard did not verify and record the write');
    assert.equal(git(snapshotStore, 'rev-parse', 'HEAD'), last.snapshot_commit);
    return last.snapshot_commit;
  };

  let diagnosis: DiagnosisReport | undefined;
  let comparison: { id: string; impact: ApprovalComparison } | undefined;
  const client = new Client({ name: 'flagradius-demo', version: '0.1.0' });
  const daemon = await startExecutorDaemon({
    engine, receiptStore, environments, proposalToken, humanApprovalToken,
    approvalComparison: card => comparison?.id === card.id ? comparison.impact : undefined,
    onDiagnose: async query => {
      diagnosis = await diagnoseTimeline({ environment: query.environment, flag: query.flag_name, identity: query.identifier,
        since: query.since, backend, snapshotDirectory: snapshotStore.directory, roster, roster_version,
        readLiveEvaluation: options.readLiveEvaluation });
      return { alignment: diagnosis.parity.verdict, snapshot_gap: diagnosis.snapshot_gap,
        candidate_fixes: diagnosis.candidates.map(({ proposal, blast_radius }) => ({ type: proposal.operation.type,
          ...('segment_id' in proposal.operation ? { segment_id: proposal.operation.segment_id } : {}), blast_radius })) };
    },
  });
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--import', 'tsx', fileURLToPath(new URL('./mcp-guard.ts', import.meta.url))],
    env: { FLAGRADIUS_EXECUTOR_URL: daemon.origin, FLAGRADIUS_PROPOSAL_TOKEN: proposalToken, FLAGRADIUS_MODE: mode }, stderr: 'ignore',
  });

  async function tool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const result = await client.callTool({ name, arguments: { ...args, environment } }, undefined, { signal });
    const data = result.structuredContent as unknown as ToolResult;
    assert(data && data.mode === mode, 'MCP response is missing the expected mode');
    assert(!result.isError, `MCP ${name} failed (${data.code ?? 'unknown'})`);
    return data;
  }

  const propose = (declared_intent: string, operation: GuardProposal['operation']) =>
    tool('propose_flag_change', { declared_intent, operation });

  function cardUrl(result: ToolResult) {
    const expected = `${daemon.origin}/approvals/${result.request_id}`;
    assert.equal(result.status, 'pending_approval');
    assert.equal(result.approval_url, expected);
    return expected;
  }

  async function loadCard(url: string) {
    const response = await fetch(url, { signal, headers: { authorization: `Bearer ${humanApprovalToken}` }, redirect: 'error' });
    assert(response.ok, 'Approval Card could not be loaded');
    const html = await response.text();
    assert(html.includes('<button>Approve</button>') && html.includes(mode), 'Approval Card does not show the pending action');
    return html;
  }

  async function submitCard(url: string, html: string, status: string) {
    const form = /<form method="post" action="([^"<>]+\/approve)">\s*<input type="hidden" name="token" value="([a-f0-9]+)">\s*<button>Approve<\/button>/.exec(html);
    assert(form && new URL(form[1], url).href === `${url}/approve` && form[2] === humanApprovalToken, 'Invalid Approve form');
    const response = await fetch(`${url}/approve`, { method: 'POST', signal, redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: daemon.origin },
      body: new URLSearchParams({ token: form[2] }) });
    assert(response.ok && (await response.text()).includes(`role="status">${status}<`), 'Approval returned an unexpected outcome');
  }

  async function observe(doc: EnvironmentDocument, identifier: string) {
    const user = roster.find(entry => entry.identifier === identifier)!;
    const expected = createFlagEvaluator(doc, flag)(user);
    const remote = await options.readLiveEvaluation(user, flag, user.traits);
    assert(remote && remote.inputs_aligned !== false, 'Identity evaluation inputs are not aligned');
    const actual = { enabled: remote.enabled, value: remote.value };
    assert.deepEqual(actual, expected, `Provider and document disagree for ${identifier}`);
    return actual;
  }

  async function act1() {
    const broad: DefaultEdit = { type: 'set_environment_default', flag_name: flag, enabled: true };
    const inspected = await tool('inspect_flags', {});
    assert.equal(inspected.status, 'inspected');
    assert.deepEqual(inspected.flags?.find(entry => entry.name === flag), { name: flag, enabled: false });
    const initial = await options.readBack();
    const broadScope = evaluateTargetedBlastRadius(initial, backend.applyOperationToDocument(initial, broad), flag, roster).total_flipped;
    assert.equal(broadScope, 2_000);
    const blocked = await propose('QA', broad);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.code, 'BLOCKED_INTENT_MISMATCH');
    assert.deepEqual(blocked.suggested_action, { type: 'set_segment_override', segment_id: qaSegmentId, name: 'internal_testers' });
    assert.deepEqual(history(blocked.request_id).map(row => row.status), ['received', 'blocked']);
    assert(isDeepStrictEqual(await options.readBack(), initial), 'Blocked request changed the environment');
    publish('act1_blocked', { intent: 'enable new_search for QA', broadScope, blocked });

    const narrowed = await propose('QA', { type: 'set_segment_override', flag_name: flag,
      segment_id: blocked.suggested_action.segment_id, enabled: true, value: 'qa' });
    const snapshotCommit = snapshotFor(narrowed.request_id);
    assert.equal(narrowed.total_flipped, 12);
    const after = await options.readBack();
    const qa = await observe(after, 'qa-01');
    const standard = await observe(after, 'standard-0001');
    assert.deepEqual(qa, { enabled: true, value: 'qa' });
    assert.deepEqual(standard, { enabled: false, value: 'control' });
    const evidence = { mode, blocked, broadScope, narrowed, snapshotCommit, qa, standard };
    publish('act1_narrowed_verified', evidence);
    return evidence;
  }

  async function act2() {
    async function simulateVipRollout(enabled: boolean, value: string) {
      const pending = await propose('vip', { type: 'set_segment_override', flag_name: flag, segment_id: vipSegmentId, enabled, value });
      const url = cardUrl(pending);
      assert.equal(pending.vip_hits, 5);
      await submitCard(url, await loadCard(url), 'snapshotted');
      return snapshotFor(pending.request_id);
    }
    await simulateVipRollout(true, 'control');
    const before = await observe(await options.readBack(), vip);
    assert.deepEqual(before, { enabled: true, value: 'control' });
    const regressionCommit = await simulateVipRollout(false, 'regression');
    const brokenDocument = await options.readBack();
    const broken = await observe(brokenDocument, vip);
    assert.deepEqual(broken, { enabled: false, value: 'regression' });
    publish('act2_regression', { before, broken, regressionCommit, segmentId: vipSegmentId });

    const beforeLog = receiptStore.readAll();
    const snapshotStatus = git(snapshotStore, 'status', '--porcelain');
    const response = await tool('diagnose_flag_incident', { flag_name: flag, identifier: vip });
    assert.equal(response.status, 'diagnosed');
    const report = diagnosis;
    assert(report, 'The executor did not run the diagnosis');
    assert.equal(report.head_commit, regressionCommit);
    assert.equal(report.parity.verdict, 'aligned');
    assert.equal(report.snapshot_gap, false);
    const transition = report.transitions.at(-1);
    assert(transition && transition.commit === regressionCommit, 'Timeline did not isolate the regression commit');
    assert.deepEqual([transition.before, transition.after], [before, broken]);
    assert.deepEqual(receiptStore.readAll(), beforeLog, 'Diagnosis changed the write receipts');
    assert.equal(git(snapshotStore, 'rev-parse', 'HEAD'), regressionCommit);
    assert.equal(git(snapshotStore, 'status', '--porcelain'), snapshotStatus);
    assert(isDeepStrictEqual(await options.readBack(), brokenDocument), 'Diagnosis changed the provider state');
    const [targeted, revert] = report.candidates;
    assert(targeted?.proposal.operation.type === 'set_identity_override' && targeted.proposal.operation.identifier === vip);
    assert(revert?.proposal.operation.type === 'set_segment_override' && revert.proposal.operation.segment_id === vipSegmentId);
    const fixes = report.candidates.map(({ proposal, blast_radius }) => ({ type: proposal.operation.type, affected: blast_radius.total_flipped }));
    assert.deepEqual(fixes, [{ type: 'set_identity_override', affected: 1 }, { type: 'set_segment_override', affected: 5 }]);
    assert.deepEqual(response.candidate_fixes?.map(fix => ({ type: fix.type, affected: fix.blast_radius.total_flipped })), fixes);
    const verifiedDiagnosis = { snapshotsReplayed: report.snapshots_replayed, alignment: report.parity.verdict,
      snapshotGap: report.snapshot_gap, unchanged: true, culprit: { segmentId: vipSegmentId, commit: transition.commit }, fixes };
    publish('act2_diagnosed', verifiedDiagnosis);

    const pending = await propose(targeted.proposal.declared_intent, targeted.proposal.operation);
    const url = cardUrl(pending);
    assert.equal(pending.total_flipped, fixes[0].affected);
    comparison = { id: pending.request_id, impact: { targeted: fixes[0].affected, revert: fixes[1].affected } };
    const html = await loadCard(url);
    assert(html.includes('Apply an identity override') && html.includes('Revert the segment override'));
    const approvalHtml = html.replaceAll(humanApprovalToken, '[REDACTED]');
    if (options.approval === 'scripted') {
      await submitCard(url, html, 'snapshotted');
    } else {
      await askForApproval(url, humanApprovalToken);
      const deadline = Date.now() + 10 * 60_000;
      while (history(pending.request_id).at(-1)?.status === 'pending_approval') {
        assert(Date.now() < deadline, 'Timed out waiting for operator approval');
        await setTimeout(250, undefined, { signal });
      }
      // Approval writes a sequence of durable receipts before returning the final card.
      while (['write_attempted', 'verified'].includes(history(pending.request_id).at(-1)?.status ?? '')) {
        assert(Date.now() < deadline, 'Timed out waiting for verified recovery');
        await setTimeout(250, undefined, { signal });
      }
    }
    const snapshotCommit = snapshotFor(pending.request_id);
    const recoveredDocument = await options.readBack();
    const recovered = await observe(recoveredDocument, vip);
    const peer = await observe(recoveredDocument, 'vip-01');
    assert.deepEqual(recovered, before);
    assert.deepEqual(peer, broken);
    const recovery = { status: 'snapshotted', approval: options.approval, requestId: pending.request_id, snapshotCommit, ...recovered };
    const evidence = { mode, before, broken, regressionCommit, diagnosis: verifiedDiagnosis, recovery, peer };
    publish('act2_recovery_verified', evidence);
    return { evidence, approvalHtml };
  }

  async function staleApproval() {
    const pending = await propose('all', { type: 'set_environment_default', flag_name: flag, enabled: true });
    const url = cardUrl(pending);
    const html = await loadCard(url);
    const edit = { type: 'set_environment_default', flag_name: flag, value: 'out-of-band' } as const;
    await options.editOutOfBand(edit);
    const edited = await options.readBack();
    assert.deepEqual(await observe(edited, 'standard-0001'), { enabled: false, value: 'out-of-band' });
    await submitCard(url, html, 'stale_approval');
    const receipts = history(pending.request_id);
    const writes = receipts.filter(receipt => receipt.status === 'write_attempted').length;
    assert.equal(writes, 0);
    assert.equal(receipts.at(-1)?.status, 'stale_approval');
    assert(isDeepStrictEqual(await options.readBack(), edited), 'Stale approval modified Flagsmith');
    const evidence = { mode, status: 'stale_approval', requestId: pending.request_id, writes, unchanged: true };
    publish('stale_approval', evidence);
    return evidence;
  }

  async function crashRecovery() {
    const pending = await propose('all', { type: 'set_environment_default', flag_name: flag, enabled: true });
    const last = history(pending.request_id).at(-1);
    assert(last?.status === 'pending_approval');
    const { operation, provider_environment_id, provider_project_id, target_baseline_state, expected_after_state } = last.plan;
    const interrupted: Receipt = { mode, environment, request_id: last.request_id, status: 'write_attempted', roster_version,
      write: { operation, provider_environment_id, provider_project_id, target_baseline_state, expected_after_state } };
    // Simulate a stop after the durable receipt and before the process invokes Flagsmith CLI.
    receiptStore.append(interrupted, 'pending_approval');
    const resume = { type: 'set_segment_override', flag_name: flag, segment_id: qaSegmentId, value: 'qa-after-reconcile' } as const;
    const locked = await propose('QA', resume);
    assert.equal(locked.code, 'ENV_CRASH_LOCKED');
    const reconciled = await engine.reconcileEnvironment(environment);
    assert.equal(reconciled.status, 'reconciled_not_applied');
    assert.equal(history(pending.request_id).at(-1)?.status, reconciled.status);
    const resumed = await propose('QA', resume);
    const snapshotCommit = snapshotFor(resumed.request_id);
    assert.equal(resumed.total_flipped, 12);
    const qa = await observe(await options.readBack(), 'qa-01');
    assert.deepEqual(qa, { enabled: true, value: resume.value });
    const evidence = { mode, locked: locked.code, status: reconciled.status, requestId: reconciled.request_id,
      resumed: { status: resumed.status, affected: resumed.total_flipped, snapshotCommit }, qa };
    publish('crash_reconciled', evidence);
    return evidence;
  }

  let pid: number | null = null;
  try {
    const connecting = client.connect(transport, { signal });
    pid = transport.pid;
    await connecting;
    assert(pid !== null && pidAlive(pid), 'MCP child did not start');
    const rollout = await act1();
    const incident = await act2();
    const stale = await staleApproval();
    const crash = await crashRecovery();
    const writeReceipts = receiptStore.readAll().map(receipt => ({
      mode: receipt.mode, request_id: receipt.request_id, environment: receipt.environment, status: receipt.status,
      ...('code' in receipt ? { code: receipt.code } : {}),
      ...('snapshot_commit' in receipt ? { snapshot_commit: receipt.snapshot_commit } : {}),
    }));
    return { mode, act1: rollout, act2: incident.evidence, approvalHtml: incident.approvalHtml, stale, crash, writeReceipts,
      teardown: { mode, mcpChildren: 0, executorListeners: 0 } };
  } finally {
    pid ??= transport.pid;
    try { await transport.close(); } finally { await daemon.close(); }
    assert(!pidAlive(pid), 'MCP child remained after shutdown');
    const listenerOpen = await fetch(daemon.origin, { signal: AbortSignal.timeout(1_000) }).then(() => true, () => false);
    assert(!listenerOpen, 'Executor still responds after shutdown');
    publish('teardown', { mcpChildren: 0, executorListeners: 0 });
  }
}

interface Seed extends Omit<FlagsmithAdapterOptions, 'apiToken'> {
  segmentId: number;
  vipSegmentId: number;
  registeredIdentities: number;
}

export async function runDemoFromEnvironment(signal?: AbortSignal) {
  const seedFile = process.env.FLAGRADIUS_DEMO_SEED_FILE;
  const tokenFile = process.env.SANDBOX_TOKEN_FILE;
  const stateDirectory = process.env.FLAGRADIUS_DEMO_STATE_DIR;
  assert(seedFile && tokenFile && stateDirectory, 'Start the sandbox with make demo or npm run demo');
  const seed: Seed = JSON.parse(await readFile(seedFile, 'utf8'));
  const url = new URL(seed.apiUrl);
  assert(url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && url.pathname === '/api/v1/'
    && !url.username && !url.password && !url.search && !url.hash && url.origin === process.env.SANDBOX_ORIGIN,
  'Demo requires the disposable loopback Flagsmith sandbox');
  assert.equal(seed.registeredIdentities, 2_000);
  const apiToken = (await readFile(tokenFile, 'utf8')).trim();
  const config = { apiUrl: url.href, apiToken, environmentKey: seed.environmentKey, projectId: seed.projectId };
  const backend = new FlagsmithAdapter(config);
  const report = await runUnifiedDemo({
    backend, stateDirectory, qaSegmentId: seed.segmentId, vipSegmentId: seed.vipSegmentId, signal,
    approval: process.env.FLAGRADIUS_DEMO_APPROVAL === 'scripted' ? 'scripted' : 'human',
    readBack: () => backend.fetchCliEnvironmentDocument(), readLiveEvaluation: createLiveEvaluationReader(config),
    emit: evidence => console.log(JSON.stringify(evidence)),
    editOutOfBand: async edit => {
      const doc = await backend.fetchEnvironmentDocument();
      const id = doc.feature_states.find(state => state.feature.name === edit.flag_name)?.django_id;
      assert(Number.isSafeInteger(id), 'Flagsmith default state is missing its API ID');
      const response = await fetch(new URL(`environments/${encodeURIComponent(config.environmentKey)}/featurestates/${id}/`, url), {
        method: 'PATCH', headers: { authorization: `Api-Key ${apiToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ feature_state_value: edit.value }), redirect: 'error', signal: AbortSignal.timeout(15_000),
      });
      assert(response.ok, `Out-of-band edit failed (HTTP ${response.status})`);
      await response.body?.cancel();
    },
  });
  const reportDirectory = process.env.FLAGRADIUS_DEMO_REPORT_DIR;
  if (reportDirectory) {
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
    const { approvalHtml, writeReceipts, ...receipts } = report;
    await writeFile(join(reportDirectory, 'receipts.json'), `${JSON.stringify(receipts, null, 2)}\n`, { mode: 0o600 });
    await writeFile(join(reportDirectory, 'write-receipts.jsonl'), `${writeReceipts.map(row => JSON.stringify(row)).join('\n')}\n`, { mode: 0o600 });
    await writeFile(join(reportDirectory, 'approval-card.html'), approvalHtml, { mode: 0o600 });
  }
  return report;
}

if (import.meta.main) {
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once('SIGTERM', stop).once('SIGINT', stop);
  await runDemoFromEnvironment(shutdown.signal).catch(error => {
    // Assertion details may contain provider documents. Export only the stage receipts and a static error label.
    console.error(JSON.stringify({ mode: liveMode, stage: 'demo_failed', error: error instanceof Error ? error.message.split('\n')[0] : 'Unexpected error' }));
    process.exitCode = 1;
  }).finally(() => process.off('SIGTERM', stop).off('SIGINT', stop));
}
