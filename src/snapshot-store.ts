import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { join, resolve } from 'node:path';
import type { RequestMetadata } from './receipt-store.js';
import type { EnvironmentDocument } from './types.js';

export interface EnvironmentSnapshot extends RequestMetadata {
  roster_version: string;
  document: EnvironmentDocument;
}

function redactDocument(doc: EnvironmentDocument): EnvironmentDocument {
  return {
    ...doc,
    api_key: '[REDACTED]',
    ...(doc.identity_overrides
      ? {
          identity_overrides: doc.identity_overrides.map(entry => {
            // Flagsmith v2.263.0 synthesizes a fresh random identity_uuid per read when serializing Postgres identities.
            const { identity_uuid: _volatileUuid, ...rest } = entry;
            return {
              ...rest,
              ...(entry.environment_api_key !== undefined ? { environment_api_key: '[REDACTED]' } : {}),
            };
          }),
        }
      : {}),
  };
}

export function normalizeDocumentForComparison(doc: EnvironmentDocument) {
  const { api_key: _key, identity_overrides, ...document } = doc;
  return {
    ...document,
    identity_overrides: Array.isArray(identity_overrides)
      ? identity_overrides.map(entry => {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
          const { environment_api_key: _identityKey, identity_uuid: _volatileUuid, ...identity } = entry;
          return identity;
        })
      : identity_overrides ?? [],
  };
}

export function sortedJson(_key: string, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return Object.fromEntries(entries);
}

export class SnapshotStore {
  readonly directory: string;

  constructor(directory = '.flagradius-state/snapshots') {
    this.directory = resolve(directory);
  }

  #git(...args: string[]): string {
    return execFileSync('git', [
      '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false',
      '-c', 'user.name=FlagRadius', '-c', 'user.email=flagradius@localhost', ...args,
    ], {
      cwd: this.directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    });
  }

  #head(): string | undefined {
    try {
      return this.#git('rev-parse', '--verify', '--quiet', 'HEAD').trim();
    } catch (error) {
      if ((error as { status?: number }).status === 1) return undefined;
      throw error;
    }
  }

  commitSnapshot(snapshot: EnvironmentSnapshot): string {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const gitDirectory = join(this.directory, '.git');
    if (!fs.existsSync(gitDirectory)) this.#git('init', '--quiet');
    if (!fs.lstatSync(gitDirectory).isDirectory()
      || fs.realpathSync(this.#git('rev-parse', '--show-toplevel').trim()) !== fs.realpathSync(this.directory)) {
      throw new Error('Snapshot store must be an isolated Git repository.');
    }
    const file = `environment-${encodeURIComponent(snapshot.environment)}.json`;
    const redacted: EnvironmentSnapshot = { ...snapshot, document: redactDocument(snapshot.document) };
    const contents = `${JSON.stringify(redacted, sortedJson, 2)}\n`;
    // After a daemon crash between commit and receipt, the same captured document can reuse HEAD.
    const head = this.#head();
    if (head && this.#git('ls-tree', '--name-only', head, '--', file).trim() === file
      && this.#git('show', `${head}:${file}`) === contents) return head;

    const fd = fs.openSync(join(this.directory, file), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW, 0o600);
    try {
      fs.writeFileSync(fd, contents);
    } finally {
      fs.closeSync(fd);
    }
    this.#git('add', '--', file);
    this.#git('commit', '--quiet', '--only', '-m', `Snapshot ${snapshot.request_id}`, '--', file);
    return this.#git('rev-parse', 'HEAD').trim();
  }
}
