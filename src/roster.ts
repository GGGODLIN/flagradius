import { readFile } from 'node:fs/promises';
import { recordObject } from './receipt-store.js';
import { FlagsmithError, isFlagValue } from './types.js';
import type { ModeTag, RosterEntry } from './types.js';

function isRosterEntry(value: unknown): value is RosterEntry {
  return recordObject(value) && typeof value.identifier === 'string' && value.identifier.trim() !== ''
    && typeof value.vip === 'boolean' && recordObject(value.traits) && Object.values(value.traits).every(isFlagValue);
}

export async function loadRosterFile(path: string, mode: ModeTag, fallbackVersion?: string) {
  try {
    const config: unknown = JSON.parse(await readFile(path, 'utf8'));
    const entries: unknown = recordObject(config) ? config.roster : config;
    const version: unknown = recordObject(config) ? config.roster_version : fallbackVersion;
    if (!Array.isArray(entries) || !entries.every(isRosterEntry) || typeof version !== 'string' || !version.trim()
      || new Set(entries.map(entry => entry.identifier)).size !== entries.length) throw new Error();
    return { roster: entries, roster_version: version };
  } catch {
    throw new FlagsmithError(mode, 'INVALID_ROSTER', 'A readable roster file with valid identities and a roster version is required.');
  }
}

function cohort(prefix: string, count: number, width: number, name: string, vip = false): RosterEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    identifier: `${prefix}-${String(i + 1).padStart(width, '0')}`,
    traits: { cohort: name }, vip,
  }));
}

export function generateRoster(): RosterEntry[] {
  return [
    ...cohort('standard', 1983, 4, 'standard'),
    ...cohort('qa', 12, 2, 'internal_testers'),
    { identifier: 'vip-acme-042', traits: { cohort: 'vip' }, vip: true },
    ...cohort('vip', 4, 2, 'vip', true),
  ];
}
