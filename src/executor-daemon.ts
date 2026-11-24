import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import { renderApprovalPage } from './approval-ui.js';
import { FlagsmithAdapter } from './flagsmith-adapter.js';
import { GuardEngine } from './guard-engine.js';
import type { ApprovalCard, FlagsmithBackend } from './guard-engine.js';
import { redactMcpPayload } from './mcp-guard.js';
import { ReceiptStore } from './receipt-store.js';
import { generateRoster } from './roster.js';
import { SnapshotStore } from './snapshot-store.js';
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
  const { environment, mode, plan } = pending;
  const { operation } = plan;
  const card: ApprovalCard = {
    id, request_id: id, mode, environment, status: 'pending', flag_name: operation.flag_name,
    target: operation.type, baseline_revision: id, blast_radius: plan.blast_radius,
    target_baseline_state: plan.target_baseline_state, reasons: plan.reasons,
    ...('segment_id' in operation && { segment_id: operation.segment_id }),
    ...('identifier' in operation && { identifier: operation.identifier }),
  };
  return { card, latest: history.at(-1)! };
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
    return render({ status: 'pending', card, segmentName, token: humanApprovalToken });
  }

  async function route(request: IncomingMessage, response: ServerResponse) {
    if (request.headers.host !== host || (request.headers.origin !== undefined && request.headers.origin !== origin)) {
      return failure(response, 403, 'EXECUTOR_FORBIDDEN');
    }
    if (request.method === 'POST' && (request.url === '/api/inspect' || request.url === '/api/propose' || request.url === '/api/diagnose')) {
      return api(request, response);
    }
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

async function runExecutor() {
  const apiToken = process.env.FLAGSMITH_API_TOKEN ?? '';
  const apiUrl = process.env.FLAGSMITH_API_URL ?? '';
  const projectId = Number(process.env.FLAGSMITH_PROJECT_ID);
  const environmentKey = process.env.FLAGSMITH_ENVIRONMENT_KEY ?? '';
  const environment = process.env.FLAGRADIUS_ENVIRONMENT ?? 'sandbox';
  const port = Number(process.env.FLAGRADIUS_EXECUTOR_PORT ?? '8788');
  if (!apiToken.trim() || !apiUrl.trim() || !environmentKey.trim() || !environment.trim() || !Number.isSafeInteger(projectId) || projectId < 1
    || !Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Incomplete live executor configuration.');

  const stateDir = process.env.FLAGRADIUS_STATE_DIR ?? '.flagradius-state';
  const receiptStore = new ReceiptStore(join(stateDir, 'receipts.jsonl'));
  const snapshotStore = new SnapshotStore(join(stateDir, 'snapshots'));
  const environments = { [environment]: new FlagsmithAdapter({ apiUrl, projectId, environmentKey, apiToken }) };
  const engine = new GuardEngine({ environments, roster: generateRoster(), roster_version: 'synthetic-v1', receiptStore, snapshotStore });
  const { origin } = await startExecutorDaemon({
    engine, receiptStore, environments, port, handleSignals: true,
    proposalToken: process.env.FLAGRADIUS_PROPOSAL_TOKEN ?? '',
    humanApprovalToken: process.env.FLAGRADIUS_HUMAN_APPROVAL_TOKEN ?? '',
  });
  console.log(JSON.stringify({ status: 'listening', mode: 'LIVE_FLAGSMITH', origin }));
}

if (import.meta.main) await runExecutor().catch(() => {
  console.error(JSON.stringify({ status: 'error', code: 'EXECUTOR_STARTUP_FAILED', mode: 'LIVE_FLAGSMITH' }));
  process.exitCode = 1;
});
