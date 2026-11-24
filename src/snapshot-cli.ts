import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { FlagsmithAdapter, validateEnvironmentDocument } from './flagsmith-adapter.js';
import type { FlagsmithBackend } from './guard-engine.js';
import { loadRosterFile } from './roster.js';
import { SnapshotStore } from './snapshot-store.js';
import { FlagsmithError } from './types.js';
import type { ModeTag } from './types.js';

type SnapshotBackend = Pick<FlagsmithBackend, 'mode' | 'fetchEnvironmentDocument'>;
interface SnapshotSources {
  backend: SnapshotBackend;
  roster_version: string;
  snapshotStore: SnapshotStore;
}

const usage = 'Usage: snapshot --env <env> [--init]';

function configuredMode(env: NodeJS.ProcessEnv): ModeTag {
  return env.FLAGSMITH_API_TOKEN && !env.FLAGRADIUS_FIXTURE_DOCUMENT ? 'LIVE_FLAGSMITH' : 'OFFLINE_FIXTURE_REPLAY';
}

async function loadSources(): Promise<SnapshotSources> {
  const env = process.env;
  const mode = configuredMode(env);
  const { roster_version } = env.FLAGRADIUS_ROSTER_PATH === undefined
    ? { roster_version: env.FLAGRADIUS_ROSTER_VERSION ?? 'synthetic-v1' }
    : await loadRosterFile(env.FLAGRADIUS_ROSTER_PATH, mode, env.FLAGRADIUS_ROSTER_VERSION);
  const snapshotStore = new SnapshotStore(env.FLAGRADIUS_SNAPSHOT_DIRECTORY
    ?? join(env.FLAGRADIUS_STATE_DIR ?? '.flagradius-state', 'snapshots'));
  if (mode === 'LIVE_FLAGSMITH') {
    const backend = new FlagsmithAdapter({
      apiUrl: env.FLAGSMITH_API_URL ?? '', projectId: Number(env.FLAGSMITH_PROJECT_ID),
      environmentKey: env.FLAGSMITH_ENVIRONMENT_KEY ?? '', apiToken: env.FLAGSMITH_API_TOKEN ?? '',
    });
    return { backend, roster_version, snapshotStore };
  }
  const fixturePath = env.FLAGRADIUS_FIXTURE_DOCUMENT;
  if (!fixturePath) throw new FlagsmithError(mode, 'INVALID_CONFIGURATION', 'Configure Flagsmith credentials or set FLAGRADIUS_FIXTURE_DOCUMENT.');
  const backend: SnapshotBackend = {
    mode,
    async fetchEnvironmentDocument() {
      try {
        return validateEnvironmentDocument(JSON.parse(await readFile(fixturePath, 'utf8')), mode);
      } catch {
        throw new FlagsmithError(mode, 'INVALID_DOCUMENT', 'The configured offline fixture is not a readable environment document.');
      }
    },
  };
  return { backend, roster_version, snapshotStore };
}

export async function runSnapshotCli(
  argv: readonly string[],
  getSources: (environment: string) => Promise<SnapshotSources> = loadSources,
  io: { stdout: (message: string) => void; stderr: (message: string) => void } = {
    stdout: message => process.stdout.write(`${message}\n`), stderr: message => process.stderr.write(`${message}\n`),
  },
): Promise<number> {
  const request_id = randomUUID();
  let mode = configuredMode(process.env);
  try {
    let environment: string | undefined;
    try {
      environment = parseArgs({ args: [...argv], options: { env: { type: 'string' }, init: { type: 'boolean' } } }).values.env;
    } catch {
      throw new FlagsmithError(mode, 'INVALID_SNAPSHOT_QUERY', usage);
    }
    if (!environment?.trim()) throw new FlagsmithError(mode, 'INVALID_SNAPSHOT_QUERY', usage);
    if (environment !== (process.env.FLAGRADIUS_ENVIRONMENT ?? 'sandbox')) {
      throw new FlagsmithError(mode, 'ENV_NOT_ALLOWED', 'The requested environment is not configured for snapshots.');
    }
    const { backend, roster_version, snapshotStore } = await getSources(environment);
    mode = backend.mode;
    const document = await backend.fetchEnvironmentDocument();
    const metadata = { mode, request_id, environment, roster_version };
    const snapshot_commit = snapshotStore.commitSnapshot({ ...metadata, document });
    io.stdout(JSON.stringify({ status: 'snapshotted', ...metadata, snapshot_commit }));
    return 0;
  } catch (error) {
    const known = error instanceof FlagsmithError;
    io.stderr(JSON.stringify({ mode: known ? error.mode : mode, request_id, code: known ? error.code : 'SNAPSHOT_FAILED',
      message: known ? error.message : 'Snapshot could not be recorded.' }));
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runSnapshotCli(process.argv.slice(2));
