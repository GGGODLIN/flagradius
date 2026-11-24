import fs from 'node:fs';
import { join } from 'node:path';
import { FlagsmithAdapter } from '../src/flagsmith-adapter.js';
import { GuardEngine } from '../src/guard-engine.js';
import type { FlagsmithBackend, GuardEngineOptions } from '../src/guard-engine.js';
import { ReceiptStore } from '../src/receipt-store.js';
import { SnapshotStore } from '../src/snapshot-store.js';
import type { EnvironmentDocument, FlagWriteOperation } from '../src/types.js';
import { document, roster } from './fixtures.js';

export const mode = 'OFFLINE_FIXTURE_REPLAY';
export const environment = 'sandbox';

class FixtureBackend extends FlagsmithAdapter implements FlagsmithBackend {
  override readonly mode = mode;
  live: EnvironmentDocument = document();
  readonly writes: FlagWriteOperation[] = [];
  reads = 0;
  beforeRead?: (read: number) => void;
  onExecute?: (operation: FlagWriteOperation) => void | Promise<void>;

  constructor() {
    super({ apiUrl: 'http://localhost', projectId: 8, environmentKey: 'synthetic-env-key', apiToken: 'fixture-only' });
  }

  override async fetchEnvironmentDocument(): Promise<EnvironmentDocument> {
    this.reads++;
    this.beforeRead?.(this.reads);
    return structuredClone(this.live);
  }

  override async execute(operation: FlagWriteOperation): Promise<void> {
    this.writes.push(operation);
    if (this.onExecute) await this.onExecute(operation);
    else this.live = this.applyOperationToDocument(this.live, operation);
  }
}

export function setup(overrides: Partial<GuardEngineOptions> = {}) {
  const directory = fs.mkdtempSync(join(import.meta.dirname, '.guard-'));
  const backend = new FixtureBackend();
  const receiptStore = new ReceiptStore(join(directory, '.flagradius-state', 'receipts.jsonl'));
  const snapshotStore = new SnapshotStore(join(directory, '.flagradius-state', 'snapshots'));
  const options: GuardEngineOptions = {
    environments: { [environment]: backend }, receiptStore, snapshotStore,
    roster: roster.slice(0, 2), roster_version: 'fixture-v1', ...overrides,
  };
  const engine = new GuardEngine(options);
  return { backend, receiptStore, snapshotStore, engine, options, cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
