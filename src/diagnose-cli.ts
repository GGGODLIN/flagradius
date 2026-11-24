import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { FlagsmithAdapter, validateEnvironmentDocument } from './flagsmith-adapter.js';
import type { FlagsmithAdapterOptions } from './flagsmith-adapter.js';
import { recordObject } from './receipt-store.js';
import { loadRosterFile } from './roster.js';
import { SnapshotStore } from './snapshot-store.js';
import { diagnoseTimeline, formatDiagnosisReport } from './timeline-diagnose.js';
import type { DiagnoseTimelineOptions } from './timeline-diagnose.js';
import { FlagsmithError, isFlagValue } from './types.js';
import type { FlagValue, ModeTag } from './types.js';

type DiagnosisQuery = Pick<DiagnoseTimelineOptions, 'environment' | 'flag' | 'identity' | 'since'>;
export type DiagnosisSources = Omit<DiagnoseTimelineOptions, keyof DiagnosisQuery>;

const usage = 'Usage: diagnose --env <env> --flag <flag> --identity <id> [--since 48h]';

export function createLiveEvaluationReader(options: FlagsmithAdapterOptions): NonNullable<DiagnoseTimelineOptions['readLiveEvaluation']> {
  return async (identity, flag, expectedTraits) => {
    let payload: unknown;
    try {
      const url = new URL(options.apiUrl);
      url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '')}/api/v1/identities/`;
      // Flagsmith's ordinary identity reads can create a missing identity. The transient SDK request can evaluate traits without persisting them.
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'X-Environment-Key': options.environmentKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier: identity.identifier, transient: true, traits: Object.entries(identity.traits)
          .map(([trait_key, trait_value]) => ({ trait_key, trait_value, transient: true })) }),
        redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      });
      if (!response.ok) throw new Error();
      payload = await response.json();
    } catch {
      throw new FlagsmithError('LIVE_FLAGSMITH', 'LIVE_EVALUATION_UNAVAILABLE', 'Flagsmith could not return a transient identity evaluation.');
    }
    if (!recordObject(payload) || !Array.isArray(payload.flags)) return null;
    const result = payload.flags.find(state => recordObject(state) && recordObject(state.feature) && state.feature.name === flag);
    if (!recordObject(result) || typeof result.enabled !== 'boolean' || !isFlagValue(result.feature_state_value)) return null;
    const inputs_aligned = Array.isArray(payload.traits) && payload.traits.every(validTrait)
      && isDeepStrictEqual(Object.fromEntries(payload.traits.filter(trait => trait.trait_value !== null)
        .map(trait => [trait.trait_key, trait.trait_value])), expectedTraits);
    return { enabled: result.enabled, value: result.feature_state_value, inputs_aligned };
  };
}

function validTrait(value: unknown): value is { trait_key: string; trait_value: FlagValue } {
  return recordObject(value) && typeof value.trait_key === 'string' && isFlagValue(value.trait_value);
}

function configuredMode(): ModeTag {
  return process.env.FLAGSMITH_API_TOKEN && !process.env.FLAGRADIUS_FIXTURE_DOCUMENT ? 'LIVE_FLAGSMITH' : 'OFFLINE_FIXTURE_REPLAY';
}

async function loadSources(environment: string): Promise<DiagnosisSources> {
  const env = process.env;
  const mode = configuredMode();
  if (environment !== (env.FLAGRADIUS_ENVIRONMENT ?? 'sandbox')) {
    throw new FlagsmithError(mode, 'ENV_NOT_ALLOWED', 'The requested environment is not configured for diagnosis.');
  }
  const { roster, roster_version } = await loadRosterFile(env.FLAGRADIUS_ROSTER_PATH ?? 'roster.json', mode, env.FLAGRADIUS_ROSTER_VERSION);
  const snapshotDirectory = new SnapshotStore(env.FLAGRADIUS_SNAPSHOT_DIRECTORY).directory;
  const options: FlagsmithAdapterOptions = {
    apiUrl: env.FLAGSMITH_API_URL ?? '', projectId: Number(env.FLAGSMITH_PROJECT_ID),
    environmentKey: env.FLAGSMITH_ENVIRONMENT_KEY ?? '', apiToken: env.FLAGSMITH_API_TOKEN ?? '',
  };
  const adapter = new FlagsmithAdapter(options);
  const sources = { roster, roster_version, snapshotDirectory };
  if (mode === 'LIVE_FLAGSMITH') return { ...sources, backend: adapter, readLiveEvaluation: createLiveEvaluationReader(options) };
  const fixturePath = env.FLAGRADIUS_FIXTURE_DOCUMENT;
  if (!fixturePath) throw new FlagsmithError(mode, 'INVALID_CONFIGURATION', 'Configure Flagsmith credentials or set FLAGRADIUS_FIXTURE_DOCUMENT.');
  return { ...sources, backend: {
    mode, applyOperationToDocument: adapter.applyOperationToDocument.bind(adapter),
    async fetchEnvironmentDocument() {
      try {
        const doc: unknown = JSON.parse(await readFile(fixturePath, 'utf8'));
        return validateEnvironmentDocument(doc, mode);
      } catch {
        throw new FlagsmithError(mode, 'INVALID_DOCUMENT', 'The configured offline fixture is not a readable environment document.');
      }
    },
  } };
}

export async function runDiagnoseCli(
  args: readonly string[],
  getSources: (environment: string) => Promise<DiagnosisSources> = loadSources,
  io: { stdout: (message: string) => void; stderr: (message: string) => void } = {
    stdout: message => process.stdout.write(`${message}\n`), stderr: message => process.stderr.write(`${message}\n`),
  },
): Promise<number> {
  let mode = configuredMode();
  try {
    let values;
    try {
      ({ values } = parseArgs({ args: [...args], options: {
        env: { type: 'string' }, flag: { type: 'string' }, identity: { type: 'string' }, since: { type: 'string' },
      } }));
    } catch {
      throw new FlagsmithError(mode, 'INVALID_DIAGNOSIS_QUERY', usage);
    }
    const { env: environment, flag, identity, since } = values;
    if (!environment?.trim() || !flag?.trim() || !identity?.trim()) throw new FlagsmithError(mode, 'INVALID_DIAGNOSIS_QUERY', usage);
    const sources = await getSources(environment);
    mode = sources.backend.mode;
    const report = await diagnoseTimeline({ ...sources, environment, flag, identity, since });
    io.stdout(formatDiagnosisReport(report));
    return 0;
  } catch (error) {
    const known = error instanceof FlagsmithError;
    io.stderr(JSON.stringify({ mode: known ? error.mode : mode, request_id: randomUUID(), code: known ? error.code : 'DIAGNOSIS_FAILED',
      message: known ? error.message : 'Diagnosis could not be completed.' }));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runDiagnoseCli(process.argv.slice(2));
