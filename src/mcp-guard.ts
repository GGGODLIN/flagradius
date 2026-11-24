import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import type { ModeTag } from './types.js';

const modeSchema = z.enum(['LIVE_FLAGSMITH', 'OFFLINE_FIXTURE_REPLAY']);
const codeSchema = z.enum([
  'APPROVAL_NOT_FOUND', 'BACKEND_MODE_CHANGED', 'BASELINE_UNAVAILABLE', 'BLOCKED_INTENT_MISMATCH',
  'CORRUPT_SNAPSHOT', 'CROSS_ENV_LOCKED', 'DIAGNOSIS_UNAVAILABLE', 'ENV_CRASH_LOCKED', 'ENV_NOT_ALLOWED',
  'EXECUTOR_ERROR', 'EXECUTOR_FORBIDDEN', 'EXECUTOR_UNAVAILABLE', 'INVALID_ARGUMENTS', 'INVALID_CONFIGURATION',
  'INVALID_DIAGNOSIS_QUERY', 'INVALID_DOCUMENT', 'INVALID_PROPOSAL', 'INVALID_WRITE_OPERATION', 'LIVE_CLI_FAILED', 'LIVE_EVALUATION_UNAVAILABLE', 'LIVE_HTTP_ERROR',
  'LIVE_UNAVAILABLE', 'NEEDS_DISAMBIGUATION', 'OVER_BUDGET', 'PROTECTED_FLAG', 'READBACK_MISMATCH', 'SNAPSHOT_NOT_FOUND', 'SNAPSHOT_REPOSITORY_UNAVAILABLE',
  'UNKNOWN_IDENTITY', 'UNSUPPORTED_FLAG_DEPENDENCY', 'VIP_IMPACT', 'WRITE_UNCONFIRMED',
]);
const statusSchema = z.enum([
  'inspected', 'diagnosed', 'error', 'blocked', 'needs_disambiguation', 'pending_approval',
  'snapshotted', 'write_unconfirmed', 'stale_approval',
]);
const segmentSchema = z.object({ segment_id: z.int().positive(), name: z.string() });
const countsSchema = z.object({
  total_evaluated: z.int().nonnegative().catch(0),
  total_flipped: z.int().nonnegative().catch(0),
  flipped_on: z.int().nonnegative().catch(0),
  flipped_off: z.int().nonnegative().catch(0),
  value_changed: z.int().nonnegative().catch(0),
  vip_hits: z.int().nonnegative().catch(0),
});
const payloadSchema = z.object({
  mode: modeSchema.optional().catch(undefined),
  request_id: z.uuid().optional().catch(undefined),
  status: statusSchema.catch('error'),
  code: codeSchema.optional().catch(undefined),
  reason_codes: z.array(codeSchema).catch([]),
  candidates: z.array(segmentSchema).catch([]),
  suggested_action: segmentSchema.extend({ type: z.literal('set_segment_override') }).optional().catch(undefined),
  flags: z.array(z.object({ name: z.string(), enabled: z.boolean() })).optional().catch(undefined),
  snapshot_gap: z.boolean().optional().catch(undefined),
  alignment: z.enum(['aligned', 'evaluation_mismatch', 'inputs_not_aligned']).optional().catch(undefined),
  candidate_fixes: z.array(z.object({
    type: z.enum(['set_identity_override', 'delete_identity_override', 'set_segment_override', 'delete_segment_override', 'set_environment_default']),
    segment_id: z.int().positive().optional().catch(undefined),
    blast_radius: countsSchema,
  })).optional().catch(undefined),
  blast_radius: countsSchema.optional().catch(undefined),
  counts: countsSchema,
});

export function redactMcpPayload(input: unknown, fallbackMode: ModeTag, origin: string) {
  const source = input && typeof input === 'object' ? input : {};
  // Rebuild nested objects as well so private receipt and provider fields cannot cross the boundary.
  const { mode, request_id, status, code, reason_codes, candidates, blast_radius, counts, ...details } =
    payloadSchema.parse({ ...source, counts: source });
  const id = request_id ?? randomUUID();
  const resultCode = code ?? (status === 'error' ? 'EXECUTOR_ERROR' : undefined);
  return {
    mode: mode ?? fallbackMode, request_id: id, status, ...(blast_radius ?? counts), candidates,
    reason_codes: [...new Set(resultCode ? [resultCode, ...reason_codes] : reason_codes)],
    ...(resultCode && { code: resultCode }),
    ...(status === 'pending_approval' && request_id && { approval_url: `${origin}/approvals/${id}` }),
    ...Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined)),
  };
}

interface McpGuardOptions {
  executorUrl: string;
  proposalToken: string;
  mode?: ModeTag;
}

const argument = (type: 'string' | 'object', description: string) => z.unknown().optional().meta({ type, description });
const environment = argument('string', 'Configured environment alias.');

export async function startMcpGuard(options: McpGuardOptions): Promise<McpServer> {
  if (Object.hasOwn(process.env, 'FLAGSMITH_API_TOKEN') || Object.hasOwn(process.env, 'FLAGRADIUS_HUMAN_APPROVAL_TOKEN')) {
    throw new Error('Privileged credentials must be excluded from the MCP environment.');
  }
  const url = new URL(options.executorUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/'
    || url.search || url.hash || !options.proposalToken.trim()) throw new Error('A loopback executor URL and proposal token are required.');
  const origin = url.origin;
  const fallbackMode = options.mode ?? 'OFFLINE_FIXTURE_REPLAY';
  const shutdown = new AbortController();
  const server = new McpServer({ name: 'flagradius-mcp-guard', version: '0.1.0' });

  function toolResult(input: unknown) {
    const payload = redactMcpPayload(input, fallbackMode, origin);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(payload) }],
      structuredContent: payload,
      ...(payload.status === 'error' && { isError: true }),
    };
  }

  async function callExecutor(path: string, input: Record<string, unknown>, signal: AbortSignal) {
    try {
      const response = await fetch(`${origin}/api/${path}`, {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${options.proposalToken}`, 'content-type': 'application/json' },
        body: JSON.stringify(input), signal: AbortSignal.any([shutdown.signal, signal, AbortSignal.timeout(30_000)]),
      });
      return toolResult(await response.json());
    } catch {
      return toolResult({ status: 'error', code: 'EXECUTOR_UNAVAILABLE' });
    }
  }

  // Validate via the daemon so malformed tool arguments always get a structured, redacted error.
  server.registerTool('inspect_flags', {
    description: 'Inspect flag names, default enabled states and segment names in one environment.',
    inputSchema: z.looseObject({ environment }).meta({ required: ['environment'] }), annotations: { readOnlyHint: true },
  }, (args, { signal }) => callExecutor('inspect', args, signal));
  server.registerTool('propose_flag_change', {
    description: 'Evaluate one flag change. Safe changes may execute automatically. Send a pending approval URL to the human operator.',
    inputSchema: z.looseObject({
      environment,
      declared_intent: argument('string', 'Intended audience, such as everyone, QA, a segment name, or a specific identity.'),
      operation: argument('object', 'Object with type and flag_name. Use set_environment_default, set_segment_override, delete_segment_override, set_identity_override, delete_identity_override, or set_multivariate_weights. Include segment_id or identifier for the matching scope, and enabled/value or weights for updates.'),
    }).meta({ required: ['environment', 'declared_intent', 'operation'] }),
  }, (args, { signal }) => callExecutor('propose', args, signal));
  server.registerTool('diagnose_flag_incident', {
    description: 'Investigate a flag incident for one identity using read-only snapshot timeline data.',
    inputSchema: z.looseObject({
      environment, flag_name: argument('string', 'Flag name.'), identifier: argument('string', 'Identity to investigate.'),
      since: argument('string', 'Optional timeline window.'),
    }).meta({ required: ['environment', 'flag_name', 'identifier'] }), annotations: { readOnlyHint: true },
  }, (args, { signal }) => callExecutor('diagnose', args, signal));

  const stop = () => {
    shutdown.abort();
    void server.close().catch(() => { process.exitCode = 1; });
  };
  server.server.onclose = () => {
    shutdown.abort();
    process.off('SIGINT', stop).off('SIGTERM', stop);
    process.stdin.off('end', stop);
  };
  await server.connect(new StdioServerTransport());
  process.once('SIGINT', stop).once('SIGTERM', stop);
  process.stdin.once('end', stop);
  return server;
}

if (import.meta.main) {
  const mode = modeSchema.safeParse(process.env.FLAGRADIUS_MODE);
  await startMcpGuard({
    executorUrl: process.env.FLAGRADIUS_EXECUTOR_URL ?? '',
    proposalToken: process.env.FLAGRADIUS_PROPOSAL_TOKEN ?? '',
    mode: mode.data,
  }).catch(() => {
    console.error(JSON.stringify({ status: 'error', code: 'MCP_STARTUP_FAILED', mode: mode.data ?? 'OFFLINE_FIXTURE_REPLAY' }));
    process.exitCode = 1;
  });
}
