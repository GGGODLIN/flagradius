import fs from 'node:fs';
import { dirname } from 'node:path';
import { validateOperation } from './flagsmith-adapter.js';
import { isFlagValue } from './types.js';
import type { BlastRadiusResult, FlagValue, FlagWriteOperation, ModeTag } from './types.js';

const ALLOWED_RECEIPT_TRANSITIONS = {
  received: ['evaluated', 'blocked', 'needs_disambiguation'],
  evaluated: ['auto_approved', 'pending_approval'],
  auto_approved: ['write_attempted', 'stale_approval', 'blocked'],
  pending_approval: ['write_attempted', 'rejected', 'stale_approval'],
  write_attempted: ['verified', 'write_unconfirmed', 'reconciled_applied', 'reconciled_not_applied'],
  write_unconfirmed: ['reconciled_applied', 'reconciled_not_applied'],
  verified: ['snapshotted', 'reconciled_applied'],
  blocked: [],
  needs_disambiguation: [],
  rejected: [],
  stale_approval: [],
  snapshotted: [],
  reconciled_applied: [],
  reconciled_not_applied: [],
} as const;

export type ReceiptStatus = keyof typeof ALLOWED_RECEIPT_TRANSITIONS;
export type ApprovalReason = 'OVER_BUDGET' | 'VIP_IMPACT' | 'PROTECTED_FLAG' | 'UNKNOWN_IDENTITY';

export interface RequestMetadata {
  mode: ModeTag;
  request_id: string;
  environment: string;
}

export interface TargetState {
  enabled: boolean;
  value: FlagValue;
  priority: number | null;
  weights: Record<number, { value: FlagValue; percentage: number }>;
}

export interface WriteContext {
  operation: FlagWriteOperation;
  provider_environment_id: number;
  provider_project_id: number;
  target_baseline_state: TargetState | null;
  expected_after_state: TargetState | null;
}

export interface ApprovalPlan extends WriteContext {
  declared_intent: string;
  affected_identities_digest: string;
  baseline_revision: string;
  blast_radius: BlastRadiusResult;
  reasons: ApprovalReason[];
  roster_version: string;
}

export type ReceiptEvent =
  | { status: 'pending_approval'; plan: ApprovalPlan }
  | { status: 'write_attempted'; write: WriteContext; roster_version: string }
  | { status: 'evaluated'; blast_radius: BlastRadiusResult }
  | { status: 'blocked' | 'needs_disambiguation' | 'write_unconfirmed'; code: string }
  | { status: 'snapshotted' | 'reconciled_applied'; snapshot_commit: string }
  | { status: 'received' | 'auto_approved' | 'rejected' | 'stale_approval' | 'verified' | 'reconciled_not_applied' };

export type Receipt = RequestMetadata & ReceiptEvent;

function permits(before: ReceiptStatus | undefined, next: ReceiptStatus): boolean {
  if (before === undefined) return next === 'received';
  const allowed: readonly ReceiptStatus[] = ALLOWED_RECEIPT_TRANSITIONS[before];
  return allowed.includes(next);
}

export function recordObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function targetState(value: unknown): value is TargetState | null {
  if (value === null) return true;
  return recordObject(value) && typeof value.enabled === 'boolean' && isFlagValue(value.value)
    && (value.priority === null || Number.isFinite(value.priority)) && recordObject(value.weights)
    && Object.values(value.weights).every(weight => recordObject(weight) && isFlagValue(weight.value) && Number.isFinite(weight.percentage));
}

function blastRadius(value: unknown): value is BlastRadiusResult {
  const fields = ['total_evaluated', 'total_flipped', 'flipped_on', 'flipped_off', 'value_changed', 'vip_hits'] as const;
  return recordObject(value) && fields.every(key => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0);
}

function writeContext(value: unknown): value is WriteContext {
  if (!recordObject(value) || !Number.isSafeInteger(value.provider_environment_id) || !Number.isSafeInteger(value.provider_project_id)
    || !targetState(value.target_baseline_state) || !targetState(value.expected_after_state)) return false;
  validateOperation(value.operation);
  return true;
}

function isReceipt(value: unknown): value is Receipt {
  if (!recordObject(value) || (value.mode !== 'LIVE_FLAGSMITH' && value.mode !== 'OFFLINE_FIXTURE_REPLAY')
    || typeof value.request_id !== 'string' || !value.request_id || typeof value.environment !== 'string') return false;
  switch (value.status) {
    case 'pending_approval': {
      const plan = value.plan;
      return recordObject(plan) && typeof plan.declared_intent === 'string' && typeof plan.roster_version === 'string'
        && typeof plan.affected_identities_digest === 'string' && typeof plan.baseline_revision === 'string'
        && Array.isArray(plan.reasons) && plan.reasons.length > 0
        && plan.reasons.every(reason => reason === 'OVER_BUDGET' || reason === 'VIP_IMPACT' || reason === 'PROTECTED_FLAG' || reason === 'UNKNOWN_IDENTITY')
        && blastRadius(plan.blast_radius) && writeContext(plan);
    }
    case 'write_attempted': return typeof value.roster_version === 'string' && writeContext(value.write);
    case 'evaluated': return blastRadius(value.blast_radius);
    case 'blocked': case 'needs_disambiguation': case 'write_unconfirmed': return typeof value.code === 'string';
    case 'snapshotted': case 'reconciled_applied': return typeof value.snapshot_commit === 'string' && !!value.snapshot_commit;
    case 'received': case 'auto_approved': case 'rejected': case 'stale_approval': case 'verified': case 'reconciled_not_applied': return true;
    default: return false;
  }
}

export class ReceiptStore {
  constructor(readonly path: string) {}

  readAll(): Receipt[] {
    let contents: string;
    try {
      contents = fs.readFileSync(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
    if (!contents) return [];
    const lines = contents.split('\n');
    if (lines.pop() !== '') throw new Error(`Corrupt receipt history at line ${lines.length + 1}: incomplete record.`);
    const latest = new Map<string, Receipt>();
    return lines.map((line, index) => {
      try {
        const value: unknown = JSON.parse(line);
        if (recordObject(value) && value.status === 'pending_approval' && recordObject(value.plan)
          && !Object.hasOwn(value.plan, 'affected_identities_digest') && !Object.hasOwn(value.plan, 'baseline_revision')) {
          // Old cards stay readable, but the missing impact proof makes any approval stale.
          value.plan.affected_identities_digest = '';
          value.plan.baseline_revision = 'unavailable';
        }
        if (!isReceipt(value)) throw new Error();
        const previous = latest.get(value.request_id);
        // Keep old terminal records readable even though new writes cannot make this transition.
        const legacyReconciliation = previous?.status === 'verified' && value.status === 'reconciled_not_applied';
        if ((!legacyReconciliation && !permits(previous?.status, value.status))
          || (previous && (previous.environment !== value.environment || previous.mode !== value.mode))) throw new Error();
        latest.set(value.request_id, value);
        return value;
      } catch {
        throw new Error(`Corrupt receipt history at line ${index + 1}: invalid record or transition.`);
      }
    });
  }

  append(receipt: Receipt, previous?: ReceiptStatus): void {
    const { status } = receipt;
    if (!permits(previous, status)) throw new Error(`Invalid receipt transition: ${previous ?? 'new'} → ${status}.`);
    if (!isReceipt(receipt)) throw new Error(`Invalid receipt payload for status ${status}.`);
    const bytes = Buffer.from(`${JSON.stringify(receipt)}\n`, 'utf8');
    const directory = dirname(this.path);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const existed = fs.existsSync(this.path);
    const fd = fs.openSync(this.path, 'a', 0o600);
    try {
      if (fs.writeSync(fd, bytes) !== bytes.length) throw new Error('Incomplete receipt write.');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (!existed) {
      // Sync the new log's directory entry before the first write can be attempted.
      const directoryFd = fs.openSync(directory, 'r');
      try {
        fs.fsyncSync(directoryFd);
      } finally {
        fs.closeSync(directoryFd);
      }
    }
  }
}
