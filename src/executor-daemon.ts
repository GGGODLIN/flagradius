import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { renderApprovalPage } from './approval-ui.js';
import type { ApprovalComparison } from './approval-ui.js';
import { createLiveEvaluationReader } from './diagnose-cli.js';
import { FlagsmithAdapter } from './flagsmith-adapter.js';
import { cardFor, GuardEngine } from './guard-engine.js';
import type { ApprovalCard, FlagsmithBackend } from './guard-engine.js';
import { redactMcpPayload } from './mcp-guard.js';
import { ReceiptStore } from './receipt-store.js';
import { generateRoster, loadRosterFile } from './roster.js';
import { SnapshotStore } from './snapshot-store.js';
import { diagnoseTimeline, summarizeDiagnosis } from './timeline-diagnose.js';
import { FlagsmithError } from './types.js';
import type { ModeTag } from './types.js';

const nonblank = z.string().refine(value => !!value.trim());
const inspectQuery = z.strictObject({ environment: nonblank });
const diagnoseQuery = inspectQuery.extend({ flag_name: nonblank, identifier: nonblank, since: nonblank.optional() });
const proposalQuery = inspectQuery.extend({ declared_intent: nonblank, operation: z.record(z.string(), z.unknown()) });
export type DiagnoseQuery = z.infer<typeof diagnoseQuery>;

export interface ExecutorDaemonOptions {
  engine: GuardEngine;
  receiptStore: ReceiptStore;
  environments: Readonly<Record<string, FlagsmithBackend>>;
  proposalToken: string;
  humanApprovalToken: string;
  port?: number;
  handleSignals?: boolean;
  onDiagnose?: (query: DiagnoseQuery) => unknown | Promise<unknown>;
  approvalComparison?: (card: ApprovalCard) => ApprovalComparison | undefined;
}

const loopback = '127.0.0.1';
const bodyLimit = 16_384;
const approvalRoute = /^\/approvals\/([a-f0-9-]{36})(?:\/(approve|reject))?$/;

function matches(token: string | undefined, expected: string): boolean {
  if (token === undefined) return false;
  const supplied = Buffer.from(token);
  const required = Buffer.from(expected);
  return supplied.length === required.length && timingSafeEqual(supplied, required);
}

function bearer(request: IncomingMessage): string | undefined {
  return /^Bearer ([^\s]+)$/i.exec(request.headers.authorization ?? '')?.[1];
}

function send(response: ServerResponse, status: number, content: string, html = false): void {
  response.writeHead(status, {
    'content-type': `${html ? 'text/html' : 'application/json'}; charset=utf-8`,
    'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  }).end(content);
}

async function readBody(request: IncomingMessage, contentType: string): Promise<string | undefined> {
  if (request.headers['content-type']?.split(';')[0].trim().toLowerCase() !== contentType) return;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > bodyLimit) return;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request, 'application/json');
  if (body === undefined) return;
  try { return JSON.parse(body) as unknown; } catch { return undefined; }
}

function readCard(receiptStore: ReceiptStore, id: string) {
  const history = receiptStore.readAll().filter(receipt => receipt.request_id === id);
  const pending = history.find(receipt => receipt.status === 'pending_approval');
  if (!pending) return;
  return { card: cardFor(pending, pending.plan), latest: history.at(-1)! };
}

export async function startExecutorDaemon(options: ExecutorDaemonOptions) {
  const { engine, receiptStore, proposalToken, humanApprovalToken, onDiagnose } = options;
  if (!proposalToken.trim() || !humanApprovalToken.trim() || /\s/.test(proposalToken) || /\s/.test(humanApprovalToken)
    || matches(proposalToken, humanApprovalToken)) throw new Error('Distinct local proposal and human approval tokens are required.');

  const environments = new Map(Object.entries(options.environments));
  const defaultMode: ModeTag = [...environments.values()].some(backend => backend.mode === 'LIVE_FLAGSMITH')
    ? 'LIVE_FLAGSMITH' : 'OFFLINE_FIXTURE_REPLAY';
  let origin: string;
  let host: string;

  function json(response: ServerResponse, status: number, data: unknown, mode = defaultMode) {
    send(response, status, JSON.stringify(redactMcpPayload(data, mode, origin)));
  }

  function failure(response: ServerResponse, status: number, code: string, mode = defaultMode) {
    json(response, status, { status: 'error', code }, mode);
  }

  async function api(request: IncomingMessage, response: ServerResponse) {
    if (!matches(bearer(request), proposalToken)) return failure(response, 403, 'EXECUTOR_FORBIDDEN');
    const input = await readJson(request);
    const envelope = inspectQuery.loose().safeParse(input);
    const backend = envelope.success ? environments.get(envelope.data.environment) : undefined;
    const mode = backend?.mode ?? defaultMode;

    try {
      if (request.url === '/api/propose') {
        const parsed = proposalQuery.safeParse(input);
        if (!parsed.success) return failure(response, 400, 'INVALID_ARGUMENTS', mode);
        const result = await engine.proposeChange(parsed.data);
        if ('code' in result && result.code === 'INVALID_PROPOSAL') {
          return json(response, 400, { ...result, status: 'error', code: 'INVALID_ARGUMENTS' }, mode);
        }
        return json(response, 200, result.status === 'pending_approval'
          ? { ...result, reason_codes: result.card.reasons } : result, mode);
      }
      if (request.url === '/api/diagnose') {
        const parsed = diagnoseQuery.safeParse(input);
        if (!parsed.success) return failure(response, 400, 'INVALID_ARGUMENTS', mode);
        if (!backend) return failure(response, 404, 'ENV_NOT_ALLOWED', mode);
        if (!onDiagnose) return failure(response, 501, 'DIAGNOSIS_UNAVAILABLE', mode);
        const summary = await onDiagnose(parsed.data);
        return json(response, 200, { ...(summary && typeof summary === 'object' ? summary : {}),
          status: 'diagnosed', mode, request_id: randomUUID() }, mode);
      }
      if (!inspectQuery.safeParse(input).success) return failure(response, 400, 'INVALID_ARGUMENTS', mode);
      if (!backend) return failure(response, 404, 'ENV_NOT_ALLOWED', mode);
      const doc = await backend.fetchEnvironmentDocument();
      return json(response, 200, {
        status: 'inspected', mode, flags: doc.feature_states.map(({ feature, enabled }) => ({ name: feature.name, enabled })),
        candidates: doc.project.segments.map(({ id, name }) => ({ segment_id: id, name })),
      }, mode);
    } catch (error) {
      return failure(response, 502, error instanceof FlagsmithError ? error.code : 'EXECUTOR_ERROR', mode);
    }
  }

  async function approval(request: IncomingMessage, response: ServerResponse, id: string, action?: string) {
    const path = `/approvals/${id}`;
    const headerToken = bearer(request);
    let token = headerToken;
    if (request.method === 'POST' && request.headers.authorization === undefined) {
      const body = await readBody(request, 'application/x-www-form-urlencoded');
      const tokens = new URLSearchParams(body).getAll('token');
      token = tokens.length === 1 ? tokens[0] : undefined;
    }
    if (!matches(token, humanApprovalToken)) {
      if (!action && request.method === 'GET' && request.headers.authorization === undefined) {
        return send(response, 200, renderApprovalPage({ path, mode: defaultMode, state: { status: 'locked' } }), true);
      }
      return failure(response, 403, 'EXECUTOR_FORBIDDEN');
    }
    const record = readCard(receiptStore, id);
    if (!record) return failure(response, 404, 'APPROVAL_NOT_FOUND');
    const { card, latest } = record;
    const render = (state: Parameters<typeof renderApprovalPage>[0]['state']) =>
      send(response, 200, renderApprovalPage({ path, mode: card.mode, state }), true);

    if (action) {
      const result = action === 'approve' ? await engine.approveCard(id) : await engine.rejectCard(id);
      return render({ status: 'terminal', result: result.status, code: 'code' in result ? result.code : undefined });
    }
    if (latest.status !== 'pending_approval') {
      return render({ status: 'terminal', result: latest.status });
    }
    const segmentName = card.segment_id === undefined ? undefined : await environments.get(card.environment)?.fetchEnvironmentDocument()
      .then(doc => doc.project.segments.find(segment => segment.id === card.segment_id)?.name).catch(() => undefined);
    return render({ status: 'pending', card, segmentName, token: humanApprovalToken, comparison: options.approvalComparison?.(card) });
  }

  async function reconcile(request: IncomingMessage, response: ServerResponse) {
    const hasAuthorization = request.headers.authorization !== undefined;
    if (hasAuthorization && !matches(bearer(request), humanApprovalToken)) return failure(response, 403, 'EXECUTOR_FORBIDDEN');
    const body = await readBody(request, 'application/x-www-form-urlencoded');
    const form = body === undefined ? undefined : new URLSearchParams(body);
    const tokens = form?.getAll('token') ?? [];
    if ((!hasAuthorization || tokens.length > 0) && (tokens.length !== 1 || !matches(tokens[0], humanApprovalToken))) {
      return failure(response, 403, 'EXECUTOR_FORBIDDEN');
    }
    const formEnvironments = form?.getAll('environment');
    const input = formEnvironments === undefined ? await readJson(request)
      : { environment: formEnvironments.length === 1 ? formEnvironments[0] : undefined };
    const parsed = inspectQuery.safeParse(input);
    if (!parsed.success) return failure(response, 400, 'INVALID_ARGUMENTS');

    const result = await engine.reconcileEnvironment(parsed.data.environment);
    const { status, mode, request_id, environment } = result;
    return send(response, 200, JSON.stringify({ status, mode, request_id, environment,
      ...('snapshot_commit' in result && { snapshot_commit: result.snapshot_commit }),
      ...('code' in result && { code: result.code }),
    }));
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.host !== host || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
      return failure(response, 403, 'EXECUTOR_FORBIDDEN');
    }
    if (request.method === 'POST' && (request.url === '/api/inspect' || request.url === '/api/propose' || request.url === '/api/diagnose')) {
      return api(request, response);
    }
    if (request.method === 'POST' && request.url === '/admin/reconcile') return reconcile(request, response);
    const match = approvalRoute.exec(request.url ?? '');
    if (match && (request.method === 'POST' || (request.method === 'GET' && !match[2]))) {
      return approval(request, response, match[1], match[2]);
    }
    return failure(response, 404, 'EXECUTOR_ERROR');
  }

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 5_000, connectionsCheckingInterval: 1_000 }, (request, response) => {
    void route(request, response).catch(() => {
      if (!response.headersSent) failure(response, 500, 'EXECUTOR_ERROR');
    });
  });
  const address = await new Promise<AddressInfo>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, loopback, () => {
      server.off('error', reject);
      resolve(server.address() as AddressInfo);
    });
  });
  host = `${loopback}:${address.port}`;
  origin = `http://${host}`;

  let closing: Promise<void> | undefined;
  const stop = () => { void close().catch(() => { process.exitCode = 1; }); };
  const close = () => closing ??= new Promise<void>((resolve, reject) => {
    server.close(error => {
      if (options.handleSignals) process.off('SIGINT', stop).off('SIGTERM', stop);
      if (error) reject(error);
      else resolve();
    });
  });
  if (options.handleSignals) process.on('SIGINT', stop).on('SIGTERM', stop);
  return { origin, close };
}

export async function buildExecutorRuntime(env: NodeJS.ProcessEnv): Promise<ExecutorDaemonOptions> {
  const apiToken = env.FLAGSMITH_API_TOKEN ?? '';
  const apiUrl = env.FLAGSMITH_API_URL ?? '';
  const projectId = Number(env.FLAGSMITH_PROJECT_ID);
  const environmentKey = env.FLAGSMITH_ENVIRONMENT_KEY ?? '';
  const environment = env.FLAGRADIUS_ENVIRONMENT ?? 'sandbox';
  const port = Number(env.FLAGRADIUS_EXECUTOR_PORT ?? '8788');
  if (!apiToken.trim() || !apiUrl.trim() || !environmentKey.trim() || !environment.trim() || !Number.isSafeInteger(projectId) || projectId < 1
    || !Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Incomplete live executor configuration.');

  const { roster, roster_version } = env.FLAGRADIUS_ROSTER_PATH === undefined
    ? { roster: generateRoster(), roster_version: env.FLAGRADIUS_ROSTER_VERSION ?? 'synthetic-v1' }
    : await loadRosterFile(env.FLAGRADIUS_ROSTER_PATH, 'LIVE_FLAGSMITH', env.FLAGRADIUS_ROSTER_VERSION);
  const protected_flags = env.FLAGRADIUS_PROTECTED_FLAGS?.split(',').map(name => name.trim()).filter(Boolean);
  const limit = env.FLAGRADIUS_MAX_SINGLE_AUTO_FLIPS?.trim();
  const max_single_auto_flips = limit === undefined ? undefined : Number(limit);
  if (limit !== undefined && (!/^\d+$/.test(limit) || !Number.isSafeInteger(max_single_auto_flips))) {
    throw new FlagsmithError('LIVE_FLAGSMITH', 'INVALID_CONFIGURATION', 'The maximum automatic flip count must be a non-negative safe integer.');
  }
  const stateDir = env.FLAGRADIUS_STATE_DIR ?? '.flagradius-state';
  const receiptStore = new ReceiptStore(join(stateDir, 'receipts.jsonl'));
  const snapshotStore = new SnapshotStore(join(stateDir, 'snapshots'));
  const adapterOptions = { apiUrl, projectId, environmentKey, apiToken };
  const environments = { [environment]: new FlagsmithAdapter(adapterOptions) };
  const engine = new GuardEngine({ environments, roster, roster_version, max_single_auto_flips, protected_flags, receiptStore, snapshotStore });
  const readLiveEvaluation = createLiveEvaluationReader(adapterOptions);
  const comparisons = new Map<string, ApprovalComparison>();
  return {
    engine, receiptStore, environments, port,
    async onDiagnose(query) {
      const diagnosis = await diagnoseTimeline({
        environment: query.environment, flag: query.flag_name, identity: query.identifier, since: query.since,
        snapshotDirectory: snapshotStore.directory, roster, roster_version, backend: environments[query.environment], readLiveEvaluation,
      });
      const key = `${query.environment}\0${query.flag_name}`;
      const targeted = diagnosis.candidates.find(candidate => candidate.kind === 'targeted');
      const revert = diagnosis.candidates.find(candidate => candidate.kind === 'revert');
      if (targeted && revert) {
        comparisons.set(key, { targeted: targeted.blast_radius.total_flipped, revert: revert.blast_radius.total_flipped });
      } else {
        comparisons.delete(key);
      }
      return summarizeDiagnosis(diagnosis);
    },
    approvalComparison: card => comparisons.get(`${card.environment}\0${card.flag_name}`),
    proposalToken: env.FLAGRADIUS_PROPOSAL_TOKEN ?? '',
    humanApprovalToken: env.FLAGRADIUS_HUMAN_APPROVAL_TOKEN ?? '',
  };
}

async function runExecutor() {
  const { origin } = await startExecutorDaemon({ ...await buildExecutorRuntime(process.env), handleSignals: true });
  console.log(JSON.stringify({ status: 'listening', mode: 'LIVE_FLAGSMITH', origin }));
}

if (import.meta.main) await runExecutor().catch((error: unknown) => {
  const code = error instanceof FlagsmithError ? error.code : 'EXECUTOR_STARTUP_FAILED';
  console.error(JSON.stringify({ status: 'error', code, mode: 'LIVE_FLAGSMITH' }));
  process.exitCode = 1;
});
