import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { evaluateTargetedImpact } from './evaluator.js';
import { validateOperation } from './flagsmith-adapter.js';
import { recordObject } from './receipt-store.js';
import type { ApprovalPlan, ApprovalReason, Receipt, ReceiptEvent, ReceiptStore, RequestMetadata, TargetState, WriteContext } from './receipt-store.js';
import { sortedJson } from './snapshot-store.js';
import type { SnapshotStore } from './snapshot-store.js';
import { FlagsmithError } from './types.js';
import type { BlastRadiusResult, EnvironmentDocument, FeatureState, FlagWriteOperation, ModeTag, RosterEntry } from './types.js';

export interface FlagsmithBackend {
  readonly mode: ModeTag;
  fetchEnvironmentDocument(): Promise<EnvironmentDocument>;
  applyOperationToDocument(doc: EnvironmentDocument, operation: FlagWriteOperation): EnvironmentDocument;
  execute(operation: FlagWriteOperation, checkedDocument: EnvironmentDocument): Promise<void>;
}

export interface GuardEngineOptions {
  environments: Readonly<Record<string, FlagsmithBackend>>;
  roster: readonly RosterEntry[];
  roster_version: string;
  max_single_auto_flips?: number;
  protected_flags?: readonly string[];
  receiptStore: ReceiptStore;
  snapshotStore: SnapshotStore;
}

export interface GuardProposal {
  environment: string;
  declared_intent: string;
  operation: FlagWriteOperation;
}

export interface ApprovalCard extends RequestMetadata {
  id: string;
  status: 'pending';
  flag_name: string;
  target: FlagWriteOperation['type'];
  segment_id?: number;
  identifier?: string;
  target_baseline_state: TargetState | null;
  baseline_revision: string;
  blast_radius: BlastRadiusResult;
  reasons: ApprovalReason[];
}

interface SegmentCandidate { segment_id: number; name: string }

export type GuardResult = RequestMetadata & (
  | { status: 'blocked' | 'needs_disambiguation'; code: string; candidates?: SegmentCandidate[]; suggested_action?: SegmentCandidate & { type: 'set_segment_override' } }
  | { status: 'pending_approval'; card: ApprovalCard; blast_radius: BlastRadiusResult }
  | { status: 'snapshotted'; snapshot_commit: string; blast_radius: BlastRadiusResult }
  | { status: 'write_unconfirmed'; code: string }
  | { status: 'reconciled_applied'; snapshot_commit: string }
  | { status: 'stale_approval' | 'rejected' | 'already_approved' | 'reconciled_not_applied' | 'no_pending_write' }
);

type AttemptReceipt = RequestMetadata & Extract<ReceiptEvent, { status: 'write_attempted' }>;
type PendingReceipt = RequestMetadata & Extract<ReceiptEvent, { status: 'pending_approval' }>;

interface ReceiptHistory {
  latest: Receipt;
  approval?: PendingReceipt;
  attempted?: AttemptReceipt;
}

function requestHistories(receipts: Receipt[]): Map<string, ReceiptHistory> {
  const histories = new Map<string, ReceiptHistory>();
  for (const receipt of receipts) {
    const history = histories.get(receipt.request_id) ?? { latest: receipt };
    history.latest = receipt;
    if (receipt.status === 'pending_approval') history.approval = receipt;
    if (receipt.status === 'write_attempted') history.attempted = receipt;
    histories.set(receipt.request_id, history);
  }
  return histories;
}

function unresolvedWrite(histories: Map<string, ReceiptHistory>, environment: string): ReceiptHistory | undefined {
  return [...histories.values()].find(({ latest }) => latest.environment === environment
    && (latest.status === 'write_attempted' || latest.status === 'write_unconfirmed' || latest.status === 'verified'));
}

function normalizeIntent(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function intentFinding(doc: EnvironmentDocument, intent: string, operation: FlagWriteOperation) {
  const narrow = normalizeIntent(intent);
  if (narrow === 'all' || narrow === 'everyone') return;
  if ('identifier' in operation && operation.identifier === intent.trim()) return;
  const names = new Set(narrow === 'qa' ? ['qa', 'internal_testers'] : [narrow]);
  const candidates = doc.project.segments.filter(segment => names.has(normalizeIntent(segment.name)))
    .map(({ id, name }) => ({ segment_id: id, name })).sort((a, b) => a.segment_id - b.segment_id);
  if ('segment_id' in operation && candidates.some(candidate => candidate.segment_id === operation.segment_id)) return;
  if (candidates.length > 1) return { status: 'needs_disambiguation', code: 'NEEDS_DISAMBIGUATION', candidates } as const;
  return {
    status: 'blocked', code: 'BLOCKED_INTENT_MISMATCH', candidates,
    ...(candidates.length === 1 && (operation.type === 'set_environment_default' || operation.type === 'set_segment_override')
      ? { suggested_action: { ...candidates[0], type: 'set_segment_override' as const } } : {}),
  } as const;
}

function targetState(doc: EnvironmentDocument, operation: FlagWriteOperation): TargetState | null {
  let states: FeatureState[] | undefined = doc.feature_states;
  if ('segment_id' in operation) {
    states = doc.project.segments.find(segment => segment.id === operation.segment_id)?.feature_states;
  } else if ('identifier' in operation) {
    states = doc.identity_overrides?.find(identity => identity.identifier === operation.identifier)?.identity_features;
  }
  const state = states?.find(state => state.feature.name === operation.flag_name);
  if (!state) return null;
  return {
    enabled: state.enabled, value: state.feature_state_value, priority: state.feature_segment?.priority ?? null,
    weights: Object.fromEntries((state.multivariate_feature_state_values ?? [])
      .filter(variant => variant.percentage_allocation !== 0)
      .map(variant => [variant.multivariate_feature_option.id, {
        percentage: variant.percentage_allocation, value: variant.multivariate_feature_option.value,
      }])),
  };
}

function sameProviderEnvironment(doc: EnvironmentDocument, context: WriteContext): boolean {
  return doc.id === context.provider_environment_id && doc.project.id === context.provider_project_id;
}

function metadata({ mode, request_id, environment }: RequestMetadata): RequestMetadata {
  return { mode, request_id, environment };
}

export function cardFor(request: RequestMetadata, plan: ApprovalPlan): ApprovalCard {
  const { operation } = plan;
  return structuredClone({
    ...metadata(request), id: request.request_id, status: 'pending',
    flag_name: operation.flag_name, target: operation.type, target_baseline_state: plan.target_baseline_state,
    ...('segment_id' in operation ? { segment_id: operation.segment_id } : {}),
    ...('identifier' in operation ? { identifier: operation.identifier } : {}),
    baseline_revision: plan.baseline_revision, blast_radius: plan.blast_radius, reasons: plan.reasons,
  });
}

export class GuardEngine {
  readonly #environments: Map<string, FlagsmithBackend>;
  readonly #roster: readonly RosterEntry[];
  readonly #rosterVersion: string;
  readonly #maxFlips: number;
  readonly #protectedFlags: ReadonlySet<string>;
  readonly #receipts: ReceiptStore;
  readonly #snapshots: SnapshotStore;
  readonly #environmentLocks = new Map<string, Promise<void>>();
  readonly #defaultMode: ModeTag;

  constructor(options: GuardEngineOptions) {
    this.#environments = new Map(Object.entries(options.environments));
    this.#roster = structuredClone(options.roster);
    this.#rosterVersion = options.roster_version;
    this.#maxFlips = options.max_single_auto_flips ?? 20;
    if (!Number.isSafeInteger(this.#maxFlips) || this.#maxFlips < 0) throw new Error('max_single_auto_flips must be a non-negative integer.');
    if (!this.#rosterVersion.trim()) throw new Error('A roster version is required.');
    this.#protectedFlags = new Set(options.protected_flags);
    this.#receipts = options.receiptStore;
    this.#snapshots = options.snapshotStore;
    this.#defaultMode = [...this.#environments.values()].some(backend => backend.mode === 'LIVE_FLAGSMITH')
      ? 'LIVE_FLAGSMITH' : 'OFFLINE_FIXTURE_REPLAY';
  }

  // This serializes one daemon's operations. Flagsmith reads and CLI writes have no server-side compare-and-swap.
  async #withEnvironment<T>(environment: string, run: () => Promise<T>): Promise<T> {
    const previous = this.#environmentLocks.get(environment);
    const { promise: current, resolve } = Promise.withResolvers<void>();
    this.#environmentLocks.set(environment, current);
    try {
      await previous;
      return await run();
    } finally {
      resolve();
      if (this.#environmentLocks.get(environment) === current) this.#environmentLocks.delete(environment);
    }
  }

  #append(request: RequestMetadata, event: ReceiptEvent, previous?: Receipt['status']): void {
    this.#receipts.append({ ...metadata(request), ...event }, previous);
  }

  #newRequest(environment: string): RequestMetadata {
    return { request_id: randomUUID(), environment, mode: this.#environments.get(environment)?.mode ?? this.#defaultMode };
  }

  async proposeChange(input: unknown): Promise<GuardResult> {
    const proposal = recordObject(input) ? input : {};
    const environment = typeof proposal.environment === 'string' ? proposal.environment : '';
    const request = this.#newRequest(environment);
    return this.#withEnvironment(environment, async () => {
      const histories = requestHistories(this.#receipts.readAll());
      this.#append(request, { status: 'received' });
      const block = (code: string): GuardResult => {
        this.#append(request, { status: 'blocked', code }, 'received');
        return { ...request, status: 'blocked', code };
      };
      if (!environment.trim()) return block('INVALID_PROPOSAL');
      const backend = this.#environments.get(environment);
      if (!backend) return block('ENV_NOT_ALLOWED');
      const operation = proposal.operation;
      if (recordObject(operation) && typeof operation.type === 'string'
        && /^(?:create|update|delete)_(?:project_)?segment(?:_rules?)?$/.test(operation.type)) return block('CROSS_ENV_LOCKED');
      if (unresolvedWrite(histories, environment)) return block('ENV_CRASH_LOCKED');
      if (typeof proposal.declared_intent !== 'string' || !proposal.declared_intent.trim()) return block('INVALID_PROPOSAL');
      const declared_intent = proposal.declared_intent;
      try {
        validateOperation(operation);
      } catch (error) {
        if (error instanceof FlagsmithError) return block('INVALID_PROPOSAL');
        throw error;
      }
      const op = structuredClone(operation);
      const before = await this.#fetchBaseline(request, backend, 'received');
      if (!Number.isSafeInteger(before.id) || !recordObject(before.project) || !Number.isSafeInteger(before.project.id)) {
        return block('INVALID_DOCUMENT');
      }
      const finding = intentFinding(before, declared_intent, op);
      if (finding) {
        this.#append(request, { status: finding.status, code: finding.code }, 'received');
        return { ...request, ...finding };
      }
      let after: EnvironmentDocument;
      let impact: ReturnType<typeof evaluateTargetedImpact>;
      try {
        after = backend.applyOperationToDocument(before, op);
        impact = evaluateTargetedImpact(before, after, op.flag_name, this.#roster);
      } catch (error) {
        if (error instanceof FlagsmithError) return block(error.code);
        throw error;
      }
      const { blast_radius, affected_identities_digest } = impact;
      const reasons = this.#approvalReasons(op, blast_radius);
      const baseline = { provider_environment_id: before.id, provider_project_id: before.project.id, target_baseline_state: targetState(before, op) };
      const fingerprint = JSON.stringify({ ...baseline, affected_identities_digest }, sortedJson);
      const baseline_revision = `rev-${createHash('sha256').update(fingerprint).digest('hex').slice(0, 12)}`;
      const plan: ApprovalPlan = {
        ...baseline, operation: op, declared_intent, ...impact, reasons, roster_version: this.#rosterVersion,
        expected_after_state: targetState(after, op), baseline_revision,
      };
      this.#append(request, { status: 'evaluated', blast_radius }, 'received');
      if (reasons.length > 0) {
        this.#append(request, { status: 'pending_approval', plan }, 'evaluated');
        return { ...request, status: 'pending_approval', card: cardFor(request, plan), blast_radius };
      }
      this.#append(request, { status: 'auto_approved' }, 'evaluated');
      return this.#execute(request, backend, plan, 'auto_approved');
    });
  }

  #approvalReasons(operation: FlagWriteOperation, impact: BlastRadiusResult): ApprovalReason[] {
    const reasons: ApprovalReason[] = [];
    if (impact.total_flipped > this.#maxFlips) reasons.push('OVER_BUDGET');
    if (impact.vip_hits > 0) reasons.push('VIP_IMPACT');
    if (this.#protectedFlags.has(operation.flag_name)) reasons.push('PROTECTED_FLAG');
    if ('identifier' in operation && !this.#roster.some(entry => entry.identifier === operation.identifier)) reasons.push('UNKNOWN_IDENTITY');
    return reasons;
  }

  approveCard(id: string): Promise<GuardResult> { return this.#resolveCard(id, 'approve'); }
  rejectCard(id: string): Promise<GuardResult> { return this.#resolveCard(id, 'reject'); }

  async #resolveCard(id: string, action: 'approve' | 'reject'): Promise<GuardResult> {
    const initial = requestHistories(this.#receipts.readAll()).get(id)?.approval;
    if (!initial) return { ...this.#newRequest(''), status: 'blocked', code: 'APPROVAL_NOT_FOUND' };
    const request = metadata(initial);
    return this.#withEnvironment(request.environment, async () => {
      const histories = requestHistories(this.#receipts.readAll());
      const history = histories.get(id);
      if (!history?.approval) return { ...request, status: 'blocked', code: 'APPROVAL_NOT_FOUND' };
      const { latest, approval } = history;
      if (latest.status === 'rejected' || latest.status === 'stale_approval') return { ...request, status: latest.status };
      if (latest.status !== 'pending_approval') return { ...request, status: 'already_approved' };
      if (action === 'reject') {
        this.#append(request, { status: 'rejected' }, 'pending_approval');
        return { ...request, status: 'rejected' };
      }
      const backend = this.#environments.get(request.environment);
      if (!backend) return { ...request, status: 'blocked', code: 'ENV_NOT_ALLOWED' };
      if (backend.mode !== request.mode) return { ...request, status: 'blocked', code: 'BACKEND_MODE_CHANGED' };
      if (unresolvedWrite(histories, request.environment)) return { ...request, status: 'blocked', code: 'ENV_CRASH_LOCKED' };
      return this.#execute(request, backend, approval.plan, 'pending_approval');
    });
  }

  async #fetchBaseline(request: RequestMetadata, backend: FlagsmithBackend, previous: 'received' | 'auto_approved' | 'pending_approval'): Promise<EnvironmentDocument> {
    try {
      return await backend.fetchEnvironmentDocument();
    } catch (error) {
      // A pending card remains usable after a transient read failure, since no write was attempted.
      if (previous !== 'pending_approval') this.#append(request, { status: 'blocked', code: 'BASELINE_UNAVAILABLE' }, previous);
      throw error;
    }
  }

  async #execute(request: RequestMetadata, backend: FlagsmithBackend, plan: ApprovalPlan, previous: 'auto_approved' | 'pending_approval'): Promise<GuardResult> {
    const { roster_version, blast_radius, declared_intent, reasons, affected_identities_digest, baseline_revision: _revision, ...write } = plan;
    const { operation, target_baseline_state, expected_after_state } = write;
    const stale = (): GuardResult => {
      this.#append(request, { status: 'stale_approval' }, previous);
      return { ...request, status: 'stale_approval' };
    };
    if (!affected_identities_digest || roster_version !== this.#rosterVersion) return stale();
    const live = await this.#fetchBaseline(request, backend, previous);
    if (!sameProviderEnvironment(live, write)
      || !isDeepStrictEqual(targetState(live, operation), target_baseline_state)
      || intentFinding(live, declared_intent, operation)) return stale();
    // A rule or another scope can change the affected identities without editing the target override itself.
    try {
      const preview = backend.applyOperationToDocument(live, operation);
      const impact = evaluateTargetedImpact(live, preview, operation.flag_name, this.#roster);
      if (!isDeepStrictEqual(targetState(preview, operation), expected_after_state)
        || !isDeepStrictEqual(impact.blast_radius, blast_radius)
        || impact.affected_identities_digest !== affected_identities_digest
        || !isDeepStrictEqual(this.#approvalReasons(operation, impact.blast_radius), reasons)) return stale();
    } catch (error) {
      if (error instanceof FlagsmithError) return stale();
      throw error;
    }

    this.#append(request, { status: 'write_attempted', write, roster_version }, previous);
    let readback: EnvironmentDocument;
    try {
      await backend.execute(operation, live);
      readback = await backend.fetchEnvironmentDocument();
    } catch {
      return this.#unconfirmed(request, 'WRITE_UNCONFIRMED');
    }
    if (!sameProviderEnvironment(readback, write) || !isDeepStrictEqual(targetState(readback, operation), expected_after_state)) {
      return this.#unconfirmed(request, 'READBACK_MISMATCH');
    }
    this.#append(request, { status: 'verified' }, 'write_attempted');
    const snapshot_commit = this.#snapshots.commitSnapshot({ ...request, roster_version, document: readback });
    this.#append(request, { status: 'snapshotted', snapshot_commit }, 'verified');
    return { ...request, status: 'snapshotted', snapshot_commit, blast_radius };
  }

  #unconfirmed(request: RequestMetadata, code: string): GuardResult {
    this.#append(request, { status: 'write_unconfirmed', code }, 'write_attempted');
    return { ...request, status: 'write_unconfirmed', code };
  }

  async reconcileEnvironment(environment: string): Promise<GuardResult> {
    const fallback = this.#newRequest(environment);
    return this.#withEnvironment(environment, async () => {
      const backend = this.#environments.get(environment);
      if (!backend) return { ...fallback, status: 'blocked', code: 'ENV_NOT_ALLOWED' };
      const history = unresolvedWrite(requestHistories(this.#receipts.readAll()), environment);
      if (!history?.attempted) return { ...fallback, status: 'no_pending_write' };
      const request = metadata(history.latest);
      if (backend.mode !== request.mode) return { ...request, status: 'blocked', code: 'BACKEND_MODE_CHANGED' };
      const { write, roster_version } = history.attempted;
      const live = await backend.fetchEnvironmentDocument();
      if (!sameProviderEnvironment(live, write)) return { ...request, status: 'blocked', code: 'ENVIRONMENT_SCOPE_CHANGED' };
      const actual = targetState(live, write.operation);
      if (isDeepStrictEqual(actual, write.expected_after_state)) {
        const snapshot_commit = this.#snapshots.commitSnapshot({ ...request, roster_version, document: live });
        this.#append(request, { status: 'reconciled_applied', snapshot_commit }, history.latest.status);
        return { ...request, status: 'reconciled_applied', snapshot_commit };
      }
      if (history.latest.status === 'verified') {
        return { ...request, status: 'write_unconfirmed', code: 'VERIFIED_DRIFT_MISMATCH' };
      }
      if (isDeepStrictEqual(actual, write.target_baseline_state)) {
        this.#append(request, { status: 'reconciled_not_applied' }, history.latest.status);
        return { ...request, status: 'reconciled_not_applied' };
      }
      // A third state is ambiguous. Keep the environment locked until an operator can reconcile the outcome.
      return { ...request, status: 'write_unconfirmed', code: 'RECONCILIATION_MISMATCH' };
    });
  }
}
