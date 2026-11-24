import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { FlagsmithBackend } from './guard-engine.js';
import { FlagsmithError } from './types.js';
import type { EnvironmentDocument, FeatureState, FlagWriteOperation, ModeTag } from './types.js';

const exec = promisify(execFile);

export function resolveFlagsmithCliPath(): string {
  const { platform, arch } = process;
  // The npm shim does not forward the child's exit code. Use the same bundled binary directly to fail closed.
  if (['darwin', 'linux', 'win32'].includes(platform) && ['x64', 'arm64'].includes(arch)) {
    const os = platform === 'win32' ? 'windows' : platform;
    const cpu = arch === 'x64' ? 'amd64' : arch;
    try {
      const manifest = createRequire(import.meta.url).resolve(`@flagsmith/cli_${os}_${cpu}/package.json`);
      return join(dirname(manifest), os === 'windows' ? 'flagsmith.exe' : 'flagsmith');
    } catch {
      // Environments with a separately managed binary can supply it on PATH.
    }
  }
  return 'flagsmith';
}

function invalidOperation(message: string): never {
  throw new FlagsmithError('OFFLINE_FIXTURE_REPLAY', 'INVALID_WRITE_OPERATION', message);
}

export function validateOperation(input: unknown): asserts input is FlagWriteOperation {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalidOperation('A flag operation is required.');
  const op = input as FlagWriteOperation;
  if (typeof op.flag_name !== 'string' || !op.flag_name.trim() || op.flag_name.startsWith('-')) invalidOperation('A valid flag name is required.');
  if (op.type === 'set_segment_override' || op.type === 'delete_segment_override') {
    if (!Number.isSafeInteger(op.segment_id) || op.segment_id <= 0) invalidOperation('Segment ID must be a positive integer.');
  } else if ('segment_id' in op) invalidOperation('Segment ID is only valid for a segment override.');
  if (op.type === 'set_identity_override' || op.type === 'delete_identity_override') {
    if (typeof op.identifier !== 'string' || !op.identifier.trim()) invalidOperation('An identity identifier is required.');
  } else if ('identifier' in op) invalidOperation('Identity identifier is only valid for an identity override.');
  switch (op.type) {
    case 'set_environment_default':
    case 'set_segment_override':
    case 'set_identity_override':
      if (op.enabled === undefined && op.value === undefined) invalidOperation('No flag change was provided.');
      if (op.enabled !== undefined && typeof op.enabled !== 'boolean') invalidOperation('Enabled must be a boolean.');
      if (op.value !== undefined && typeof op.value !== 'boolean' && typeof op.value !== 'string' && !Number.isSafeInteger(op.value)) {
        invalidOperation('CLI flag values must be booleans, strings or safe integers.');
      }
      break;
    case 'set_multivariate_weights': {
      if (!op.weights || typeof op.weights !== 'object' || Array.isArray(op.weights)) invalidOperation('Variant weights are required.');
      const weights = Object.entries(op.weights);
      if (weights.length === 0 || weights.some(([id, weight]) => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)) || !Number.isFinite(weight) || weight < 0 || weight > 100)) {
        invalidOperation('Provide variant IDs with percentage weights from 0 to 100.');
      }
      break;
    }
    case 'delete_segment_override':
    case 'delete_identity_override':
      break;
    default:
      invalidOperation('Only environment-scoped flag writes are supported.');
  }
}

function writeArguments(op: FlagWriteOperation): string[] {
  if (op.type === 'delete_segment_override') return ['flag', 'delete', op.flag_name, `--segment=${op.segment_id}`];
  if (op.type === 'delete_identity_override') return ['flag', 'delete', op.flag_name, `--identifier=${op.identifier}`];
  const args = ['flag', 'update', op.flag_name];
  if (op.type === 'set_multivariate_weights') return args.concat(Object.entries(op.weights).map(([id, value]) => `--weight=${id}=${value}`));
  if (op.type === 'set_segment_override') args.push(`--segment=${op.segment_id}`);
  if (op.type === 'set_identity_override') args.push(`--identifier=${op.identifier}`);
  if (op.enabled !== undefined) args.push(op.enabled ? '--enable' : '--disable');
  if (op.value !== undefined) args.push(`--value=${op.value}`, `--type=${typeof op.value === 'number' ? 'integer' : typeof op.value}`);
  return args;
}

function patchState(state: FeatureState, op: Extract<FlagWriteOperation, { type: 'set_environment_default' | 'set_segment_override' | 'set_identity_override' }>): FeatureState {
  return { ...state, enabled: op.enabled ?? state.enabled, feature_state_value: op.value ?? state.feature_state_value };
}

function newOverride(base: FeatureState): FeatureState {
  return { feature: base.feature, feature_state_value: base.feature_state_value, enabled: base.enabled };
}

function liveFailure(code: string, message: string, status?: number): FlagsmithError {
  return new FlagsmithError('LIVE_FLAGSMITH', code, message, status);
}

function httpFailure(status: number): FlagsmithError {
  return liveFailure('LIVE_HTTP_ERROR', `Flagsmith rejected the request (HTTP ${status}).`, status);
}

function parseDocument(value: unknown, expectedEnvironment: string, projectId: number): EnvironmentDocument {
  const doc = value as Partial<EnvironmentDocument> | null;
  if (!doc || doc.api_key !== expectedEnvironment || doc.project?.id !== projectId || !Array.isArray(doc.project.segments) || !Array.isArray(doc.feature_states) || (doc.identity_overrides !== undefined && !Array.isArray(doc.identity_overrides))) {
    throw liveFailure('INVALID_DOCUMENT', 'The response is not an environment document for the configured scope.');
  }
  return doc as EnvironmentDocument;
}

export interface FlagsmithAdapterOptions {
  apiUrl: string;
  projectId: number;
  environmentKey: string;
  apiToken: string;
  cliPath?: string;
  timeoutMs?: number;
}

export class FlagsmithAdapter implements FlagsmithBackend {
  readonly mode: ModeTag = 'LIVE_FLAGSMITH';
  readonly #options: FlagsmithAdapterOptions;

  constructor(options: FlagsmithAdapterOptions) {
    this.#options = { ...options };
  }

  applyOperationToDocument(doc: EnvironmentDocument, op: FlagWriteOperation): EnvironmentDocument {
    validateOperation(op);
    const result = structuredClone(doc);
    const isTarget = (state: FeatureState) => state.feature.name === op.flag_name;
    const baseIndex = result.feature_states.findIndex(isTarget);
    if (baseIndex < 0) return invalidOperation('Flag not found in the environment.');
    const base = result.feature_states[baseIndex];
    switch (op.type) {
      case 'set_environment_default':
        result.feature_states[baseIndex] = patchState(base, op);
        break;
      case 'set_segment_override':
      case 'delete_segment_override': {
        const segment = result.project.segments.find(segment => segment.id === op.segment_id);
        if (!segment) return invalidOperation('Segment not found in the project.');
        const index = segment.feature_states.findIndex(isTarget);
        if (op.type === 'delete_segment_override') {
          if (index < 0) return invalidOperation('Segment has no override for the flag.');
          segment.feature_states.splice(index, 1);
        } else if (index >= 0) {
          segment.feature_states[index] = patchState(segment.feature_states[index], op);
        } else {
          const inheritedWeights = base.multivariate_feature_state_values ?? [];
          // The provider assigns a new state ID, which is part of the rollout bucket key.
          if (inheritedWeights.some(variant => variant.percentage_allocation > 0)) {
            return invalidOperation('Cannot predict rollout buckets before the weighted segment override has a provider state ID.');
          }
          const priorities = result.project.segments.flatMap(({ feature_states }) => feature_states.filter(isTarget).map(state => state.feature_segment?.priority ?? 0));
          const priority = Math.max(-1, ...priorities) + 1;
          segment.feature_states.push({ ...patchState(newOverride(base), op), feature_segment: { priority } });
        }
        break;
      }
      case 'set_identity_override':
      case 'delete_identity_override': {
        const overrides = result.identity_overrides ??= [];
        let identity = overrides.find(identity => identity.identifier === op.identifier);
        if (op.type === 'delete_identity_override') {
          const index = identity?.identity_features.findIndex(isTarget) ?? -1;
          if (!identity || index < 0) return invalidOperation('Identity has no override for the flag.');
          identity.identity_features.splice(index, 1);
          if (identity.identity_features.length === 0) overrides.splice(overrides.indexOf(identity), 1);
        } else {
          if (!identity) {
            identity = { identifier: op.identifier, environment_api_key: doc.api_key, identity_features: [] };
            overrides.push(identity);
          }
          const index = identity.identity_features.findIndex(isTarget);
          if (index >= 0) identity.identity_features[index] = patchState(identity.identity_features[index], op);
          else identity.identity_features.push(patchState(newOverride(base), op));
        }
        break;
      }
      case 'set_multivariate_weights': {
        const variants = base.multivariate_feature_state_values ?? [];
        const ids = new Set(variants.map(variant => variant.multivariate_feature_option.id));
        if (Object.keys(op.weights).some(id => !ids.has(Number(id)))) return invalidOperation('Variant not found in the environment flag state.');
        for (const variant of variants) {
          const id = variant.multivariate_feature_option.id;
          if (Object.hasOwn(op.weights, id)) variant.percentage_allocation = op.weights[id];
        }
        if (variants.reduce((sum, variant) => sum + variant.percentage_allocation, 0) > 100 + 1e-9) {
          return invalidOperation('Merged variant weights exceed 100 percent.');
        }
        break;
      }
    }
    return result;
  }

  #apiBase(): URL {
    const { apiUrl, apiToken, environmentKey, projectId } = this.#options;
    try {
      const url = new URL(apiUrl);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      if (!apiToken || !environmentKey || !Number.isSafeInteger(projectId) || projectId < 1) throw new Error();
      url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
      return url;
    } catch {
      throw liveFailure('INVALID_CONFIGURATION', 'A Flagsmith API base URL, project, environment key and admin credential are required.');
    }
  }

  async execute(op: FlagWriteOperation, checkedDocument?: EnvironmentDocument): Promise<void> {
    const before = checkedDocument === undefined
      ? await this.fetchEnvironmentDocument()
      : parseDocument(checkedDocument, this.#options.environmentKey, this.#options.projectId);
    this.applyOperationToDocument(before, op);
    await this.#runCli(writeArguments(op));
  }

  async #runCli(args: string[]): Promise<string> {
    const base = this.#apiBase();
    const { apiToken, environmentKey, projectId, cliPath, timeoutMs } = this.#options;
    let home: string | undefined;
    try {
      home = await mkdtemp(join(tmpdir(), 'flagradius-cli-'));
      const host = base.host.replace(/[\[\]]/g, '').replace(/-/g, '__').replace(/[.:]/g, '_');
      const cli = cliPath ?? resolveFlagsmithCliPath();
      const { stdout } = await exec(cli, [
        ...args, `--api-url=${base.href.replace(/\/$/, '')}`, `--project=${projectId}`,
        `--environment=${environmentKey}`, '--no-input', '--yes', '--json',
      ], {
        cwd: home,
        env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, [`FLAGSMITH_API_KEY_${host}`]: apiToken },
        timeout: timeoutMs ?? 30_000,
        maxBuffer: 8 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      // Never expose raw CLI output, argv, or the original exception: any of them can contain credentials.
      const stderr = (error as { stderr?: string }).stderr ?? '';
      const status = /\breturned ([45]\d\d)\b/.exec(stderr)?.[1];
      if (status) throw httpFailure(Number(status));
      throw liveFailure('LIVE_CLI_FAILED', 'The Flagsmith CLI did not confirm success.');
    } finally {
      if (home) await rm(home, { recursive: true, force: true });
    }
  }

  async fetchEnvironmentDocument(): Promise<EnvironmentDocument> {
    const base = this.#apiBase();
    const { apiToken, environmentKey, projectId, timeoutMs } = this.#options;
    const apiUrl = `${base.href.replace(/\/$/, '')}/api/v1/environments/${encodeURIComponent(environmentKey)}/document/`;
    try {
      const response = await fetch(apiUrl, {
        headers: { Authorization: `Api-Key ${apiToken}` },
        signal: AbortSignal.timeout(timeoutMs ?? 15_000),
        redirect: 'error',
      });
      if (!response.ok) throw httpFailure(response.status);
      return parseDocument(await response.json(), environmentKey, projectId);
    } catch (error) {
      if (error instanceof FlagsmithError) throw error;
      if (error instanceof SyntaxError) throw liveFailure('INVALID_DOCUMENT', 'Flagsmith returned malformed document JSON.');
      throw liveFailure('LIVE_UNAVAILABLE', 'The Flagsmith environment document could not be retrieved.');
    }
  }

  async fetchCliEnvironmentDocument(): Promise<EnvironmentDocument> {
    const output = await this.#runCli(['environment', 'document']);
    try {
      return parseDocument(JSON.parse(output), this.#options.environmentKey, this.#options.projectId);
    } catch {
      throw liveFailure('INVALID_DOCUMENT', 'The CLI returned an invalid environment document for the configured scope.');
    }
  }
}
