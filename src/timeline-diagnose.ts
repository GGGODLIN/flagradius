import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { createFlagEvaluator, evaluateTargetedBlastRadius } from './evaluator.js';
import type { FlagsmithBackend, GuardProposal } from './guard-engine.js';
import { recordObject } from './receipt-store.js';
import type { EnvironmentSnapshot } from './snapshot-store.js';
import { FlagsmithError } from './types.js';
import type { BlastRadiusResult, EnvironmentDocument, FeatureState, FlagValue, FlagWriteOperation, ModeTag, RosterEntry, SegmentRule } from './types.js';

const exec = promisify(execFile);
const hours = 3_600_000;

export interface DiagnosisEvaluation {
  enabled: boolean;
  value: FlagValue;
}

export interface DiagnoseTimelineOptions {
  environment: string;
  flag: string;
  identity: string;
  since?: string;
  now?: number;
  snapshotDirectory: string;
  roster: readonly RosterEntry[];
  roster_version: string;
  backend: Pick<FlagsmithBackend, 'mode' | 'fetchEnvironmentDocument' | 'applyOperationToDocument'>;
  readLiveEvaluation?: (identity: RosterEntry, flag: string, expectedTraits: Readonly<Record<string, FlagValue>>)
    => Promise<(DiagnosisEvaluation & { inputs_aligned?: boolean }) | null>;
}

export interface TimelineTransition {
  commit: string;
  committed_at: string;
  request_id: string;
  before: DiagnosisEvaluation;
  after: DiagnosisEvaluation;
}

export interface DiagnosisCandidate {
  kind: 'targeted' | 'revert';
  proposal: GuardProposal;
  blast_radius: BlastRadiusResult;
}

export interface DiagnosisReport {
  mode: ModeTag;
  request_id: string;
  environment: string;
  flag: string;
  head_commit: string;
  snapshots_replayed: number;
  transitions: TimelineTransition[];
  timeline_message: string | null;
  snapshot_gap: boolean;
  snapshot_gap_reason: 'external_drift_unrecorded' | null;
  parity: {
    verdict: 'aligned' | 'evaluation_mismatch' | 'inputs_not_aligned';
    live: DiagnosisEvaluation | null;
    offline: DiagnosisEvaluation | null;
  };
  candidates: DiagnosisCandidate[];
}

interface Commit {
  sha: string;
  timestamp: number;
}

interface ReplayFrame {
  snapshot: EnvironmentSnapshot;
  evaluation: DiagnosisEvaluation | null;
}

interface Incident {
  before: ReplayFrame & { evaluation: DiagnosisEvaluation };
  after: ReplayFrame & { evaluation: DiagnosisEvaluation };
}

export function isDiagnosisValue(value: unknown): value is FlagValue {
  return value === null || typeof value === 'string' || typeof value === 'boolean' || Number.isFinite(value);
}

function cutoffTime(options: DiagnoseTimelineOptions): number {
  const duration = /^(\d+)([mhd])$/.exec(options.since ?? '48h');
  const unit = duration?.[2] === 'm' ? hours / 60 : duration?.[2] === 'd' ? 24 * hours : hours;
  const milliseconds = duration ? Number(duration[1]) * unit : NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) {
    throw new FlagsmithError(options.backend.mode, 'INVALID_DIAGNOSIS_QUERY', 'Use a positive --since duration such as 30m, 48h or 7d.');
  }
  // Git commit timestamps are stored at second resolution.
  return Math.floor(((options.now ?? Date.now()) - milliseconds) / 1000);
}

async function snapshotHistory(options: DiagnoseTimelineOptions) {
  const { snapshotDirectory, backend: { mode } } = options;
  const git = async (...args: string[]) => (await exec('git', args, {
    cwd: snapshotDirectory, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_NO_REPLACE_OBJECTS: '1' },
  })).stdout;
  const filename = `environment-${encodeURIComponent(options.environment)}.json`;
  let commits: Commit[];
  try {
    if (!(await lstat(join(snapshotDirectory, '.git'))).isDirectory()
      || await realpath((await git('rev-parse', '--show-toplevel')).trimEnd()) !== await realpath(snapshotDirectory)) throw new Error();
    const head = (await git('rev-parse', '--verify', 'HEAD^{commit}')).trim();
    const history = (await git('log', '--reverse', '--first-parent', '--full-history', '--diff-merges=first-parent', '--format=%H%x00%ct', head, '--', filename)).trim();
    commits = history ? history.split('\n').map(line => {
      const [sha, timestamp] = line.split('\0');
      return { sha, timestamp: Number(timestamp) };
    }) : [];
  } catch {
    throw new FlagsmithError(mode, 'SNAPSHOT_REPOSITORY_UNAVAILABLE', 'The snapshot directory must be a readable, isolated Git repository with a committed HEAD.');
  }
  if (commits.length === 0) {
    throw new FlagsmithError(mode, 'SNAPSHOT_NOT_FOUND', 'The snapshot repository has no committed history for this environment.');
  }
  const read = async (sha: string): Promise<EnvironmentSnapshot> => {
    try {
      const snapshot: unknown = JSON.parse(await git('cat-file', 'blob', `${sha}:${filename}`));
      if (!recordObject(snapshot) || snapshot.environment !== options.environment || !recordObject(snapshot.document)
        || (snapshot.mode !== 'LIVE_FLAGSMITH' && snapshot.mode !== 'OFFLINE_FIXTURE_REPLAY')
        || typeof snapshot.request_id !== 'string' || typeof snapshot.roster_version !== 'string') throw new Error();
      return snapshot as unknown as EnvironmentSnapshot;
    } catch {
      throw new FlagsmithError(mode, 'CORRUPT_SNAPSHOT', `Cannot read the environment snapshot at commit ${sha}. Expected a valid snapshot JSON document.`);
    }
  };
  return { commits, read };
}

function withoutCredentials(doc: EnvironmentDocument) {
  const { api_key: _key, identity_overrides, ...document } = doc;
  return {
    ...document,
    identity_overrides: Array.isArray(identity_overrides) ? identity_overrides.map(entry => {
      if (!recordObject(entry)) return entry;
      const { environment_api_key: _identityKey, ...identity } = entry;
      return identity;
    }) : identity_overrides ?? [],
  };
}

function validRule(rule: SegmentRule, traits: ReadonlySet<string>): boolean {
  return ['ALL', 'ANY', 'NONE'].includes(rule?.type) && Array.isArray(rule.rules) && Array.isArray(rule.conditions)
    && rule.conditions.every(condition => condition && typeof condition.operator === 'string'
      && (condition.operator === 'PERCENTAGE_SPLIT' || (typeof condition.property_ === 'string'
        && (traits.has(condition.property_) || ['IS_SET', 'IS_NOT_SET'].includes(condition.operator))))
      && (condition.value === null || typeof condition.value === 'string'))
    && rule.rules.every(child => validRule(child, traits));
}

function flagInputs(doc: EnvironmentDocument, flag: string, entry: RosterEntry) {
  if (!Number.isSafeInteger(doc.id) || !Number.isSafeInteger(doc.project?.id) || !recordObject(doc.project.organisation)
    || !Array.isArray(doc.feature_states) || !Array.isArray(doc.project.segments)
    || (doc.identity_overrides !== undefined && !Array.isArray(doc.identity_overrides))) return null;
  const targetStates = (states: FeatureState[]) => states.filter(state => state.feature.name === flag);
  const defaults = targetStates(doc.feature_states);
  const identity = doc.identity_overrides?.find(identity => identity.identifier === entry.identifier);
  const identityStates = identity ? targetStates(identity.identity_features) : [];
  const segments = doc.project.segments.flatMap(segment => {
    const states = targetStates(segment.feature_states);
    return states.length ? [{ id: segment.id, rules: segment.rules, states }] : [];
  });
  const states = [...defaults, ...identityStates, ...segments.flatMap(segment => segment.states)];
  if (defaults.length !== 1 || identityStates.length > 1 || segments.some(segment => segment.states.length > 1)
    || states.some(state => !Number.isSafeInteger(state.feature.id) || !['STANDARD', 'MULTIVARIATE'].includes(state.feature.type)
      || typeof state.enabled !== 'boolean' || !isDiagnosisValue(state.feature_state_value))) return null;
  const storedTraits = identity?.identity_traits ?? [];
  if (!Array.isArray(storedTraits) || storedTraits.some(trait => !trait || typeof trait.trait_key !== 'string' || !isDiagnosisValue(trait.trait_value))) return null;
  const traits = new Set([...storedTraits.map(trait => trait.trait_key), ...Object.keys(entry.traits)]);
  if (identityStates.length === 0 && segments.some(segment => !Array.isArray(segment.rules) || segment.rules.some(rule => !validRule(rule, traits)))) return null;
  return {
    environment: doc.id, project: doc.project.id, defaults, segments, identityStates, storedTraits,
    stop_serving_flags: doc.project.organisation.stop_serving_flags ?? false,
    hide_disabled_flags: doc.project.hide_disabled_flags ?? false,
  };
}

function evaluate(doc: EnvironmentDocument, flag: string, entry?: RosterEntry) {
  if (!entry || !recordObject(entry.traits) || !Object.values(entry.traits).every(isDiagnosisValue)) return null;
  try {
    const inputs = flagInputs(doc, flag, entry);
    if (!inputs) return null;
    const result = createFlagEvaluator(doc, flag)(entry);
    return isDiagnosisValue(result.value) ? { inputs, result } : null;
  } catch (error) {
    if (error instanceof FlagsmithError || error instanceof TypeError) return null;
    throw error;
  }
}

type OverrideScope = { declared_intent: string } & ({ segment_id: number } | { identifier: string } | { default: true });

type ScopedState = Pick<FeatureState, 'enabled' | 'feature_state_value' | 'feature_segment' | 'featurestate_uuid' | 'django_id' | 'multivariate_feature_state_values'>;

function reversibleState(state?: FeatureState): ScopedState | undefined {
  if (!state) return;
  const { enabled, feature_state_value, feature_segment, featurestate_uuid, django_id, multivariate_feature_state_values } = state;
  return { enabled, feature_state_value, feature_segment, featurestate_uuid, django_id, multivariate_feature_state_values };
}

function valueToWrite(value: FlagValue): value is Exclude<FlagValue, null> {
  return typeof value === 'boolean' || typeof value === 'string' || Number.isSafeInteger(value);
}

function restoreScope(
  flag_name: string, scope: OverrideScope, before: ScopedState | undefined, after: ScopedState | undefined, live: ScopedState | undefined,
): FlagWriteOperation | undefined {
  if (isDeepStrictEqual(before, after)) return;
  if (!before) {
    if (!isDeepStrictEqual(live, after)) return;
    if ('segment_id' in scope) return { type: 'delete_segment_override', flag_name, segment_id: scope.segment_id };
    if ('identifier' in scope) return { type: 'delete_identity_override', flag_name, identifier: scope.identifier };
    return;
  }
  if (!after) {
    // Creating an override cannot restore its old provider ID, priority or rollout weights.
    return;
  }
  if (!live) return;
  const enabledChanged = before.enabled !== after.enabled;
  const valueChanged = before.feature_state_value !== after.feature_state_value;
  const restoreEnabled = enabledChanged && live.enabled === after.enabled;
  const restoreValue = valueChanged && live.feature_state_value === after.feature_state_value;
  if (valueChanged && !restoreValue && live.feature_state_value !== before.feature_state_value) return;
  const beforeValue = before.feature_state_value;
  if (restoreValue && !valueToWrite(beforeValue)) return;
  if (!restoreEnabled && !restoreValue) return;
  const value = restoreValue && valueToWrite(beforeValue) ? { value: beforeValue } : {};
  const fields = { flag_name, enabled: restoreEnabled ? before.enabled : live.enabled, ...value };
  if ('segment_id' in scope) return { type: 'set_segment_override', segment_id: scope.segment_id, ...fields };
  if ('identifier' in scope) return { type: 'set_identity_override', identifier: scope.identifier, ...fields };
  return { type: 'set_environment_default', ...fields };
}

function recoveryProposals(incident: Incident, live: EnvironmentDocument, options: DiagnoseTimelineOptions): GuardProposal[] {
  const { flag: flag_name, identity, environment } = options;
  const docs = [incident.before.snapshot.document, incident.after.snapshot.document, live];
  const proposals: GuardProposal[] = [];
  const inspect = (scope: OverrideScope, states: (doc: EnvironmentDocument) => FeatureState[] | undefined) => {
    const [before, after, current] = docs.map(doc => reversibleState(states(doc)?.find(state => state.feature.name === flag_name)));
    const operation = restoreScope(flag_name, scope, before, after, current);
    if (operation) proposals.push({ environment, declared_intent: scope.declared_intent, operation });
  };
  inspect({ identifier: identity, declared_intent: identity }, doc =>
    doc.identity_overrides?.find(entry => entry.identifier === identity)?.identity_features);
  for (const segment of live.project.segments) {
    inspect({ segment_id: segment.id, declared_intent: segment.name }, doc =>
      doc.project.segments.find(entry => entry.id === segment.id)?.feature_states);
  }
  inspect({ default: true, declared_intent: 'all' }, doc => doc.feature_states);
  return proposals;
}

function compareRecovery(
  incident: Incident, doc: EnvironmentDocument, current: DiagnosisEvaluation, entry: RosterEntry, options: DiagnoseTimelineOptions,
): DiagnosisCandidate[] {
  const before = incident.before.evaluation;
  const after = incident.after.evaluation;
  const enabledChanged = before.enabled !== after.enabled;
  const valueChanged = before.value !== after.value;
  if ((!enabledChanged || current.enabled !== after.enabled) && (!valueChanged || current.value !== after.value)) return [];
  const desired = { enabled: enabledChanged ? before.enabled : current.enabled, value: valueChanged ? before.value : current.value };
  const candidates: DiagnosisCandidate[] = [];
  const preview = (kind: DiagnosisCandidate['kind'], proposal: GuardProposal) => {
    const { operation } = proposal;
    try {
      const changed = options.backend.applyOperationToDocument(doc, operation);
      const result = createFlagEvaluator(changed, options.flag)(entry);
      if (!isDeepStrictEqual(result, desired)) return;
      const blast_radius = evaluateTargetedBlastRadius(doc, changed, options.flag, options.roster);
      if (!blast_radius.total_flipped) return;
      if (candidates.some(candidate => isDeepStrictEqual(candidate.proposal.operation, operation))) return;
      candidates.push({ kind, proposal, blast_radius });
    } catch (error) {
      if (!(error instanceof FlagsmithError)) throw error;
    }
  };
  const reverts = recoveryProposals(incident, doc, options);
  const removeIdentity = reverts.find(proposal => proposal.operation.type === 'delete_identity_override');
  if (removeIdentity) preview('targeted', removeIdentity);
  if (candidates.length === 0) {
    const value = valueToWrite(desired.value) ? { value: desired.value } : {};
    preview('targeted', { environment: options.environment, declared_intent: entry.identifier, operation: {
      type: 'set_identity_override', flag_name: options.flag, identifier: entry.identifier, enabled: desired.enabled, ...value,
    } });
  }
  for (const revert of reverts) preview('revert', revert);
  return candidates;
}

export async function diagnoseTimeline(options: DiagnoseTimelineOptions): Promise<DiagnosisReport> {
  const { backend, environment, flag, identity, roster, roster_version } = options;
  const cutoff = cutoffTime(options);
  const { commits, read } = await snapshotHistory(options);
  const entry = roster.find(entry => entry.identifier === identity);
  const transitions: TimelineTransition[] = [];
  let previous: ReplayFrame | undefined;
  let incident: Incident | undefined;
  let snapshots_replayed = 0;
  let incomplete = false;
  const head = commits[commits.length - 1];
  for (const [index, commit] of commits.entries()) {
    const inWindow = commit.timestamp >= cutoff;
    const next = commits[index + 1];
    if (!inWindow && commit !== head && (!next || next.timestamp < cutoff)) continue;
    const snapshot = await read(commit.sha);
    const evaluation = snapshot.roster_version === roster_version ? evaluate(snapshot.document, flag, entry)?.result ?? null : null;
    if (inWindow) {
      snapshots_replayed++;
      if (!evaluation || (previous && !previous.evaluation)) incomplete = true;
      if (previous?.evaluation && evaluation && !isDeepStrictEqual(previous.evaluation, evaluation)) {
        incident = {
          before: { snapshot: previous.snapshot, evaluation: previous.evaluation }, after: { snapshot, evaluation },
        };
        transitions.push({
          commit: commit.sha, committed_at: new Date(commit.timestamp * 1000).toISOString(), request_id: snapshot.request_id,
          before: previous.evaluation, after: evaluation,
        });
      }
    }
    previous = { snapshot, evaluation };
  }

  const recorded = previous!.snapshot;
  const live = await backend.fetchEnvironmentDocument();
  const current = evaluate(live, flag, entry);
  const offline = evaluate(recorded.document, flag, entry);
  const snapshot_gap = !isDeepStrictEqual(withoutCredentials(recorded.document), withoutCredentials(live));
  const expectedTraits = (current && entry) ? Object.fromEntries(Object.entries({
    ...Object.fromEntries(current.inputs.storedTraits.map(trait => [trait.trait_key, trait.trait_value])), ...entry.traits,
  }).filter(([, value]) => value !== null)) : {};
  const remote = entry && current && options.readLiveEvaluation ? await options.readLiveEvaluation(entry, flag, expectedTraits) : null;
  const liveEvaluation = remote ? { enabled: remote.enabled, value: remote.value }
    : backend.mode === 'OFFLINE_FIXTURE_REPLAY' ? current?.result ?? null : null;
  const alignedInputs = liveEvaluation !== null && remote?.inputs_aligned !== false && offline !== null && current !== null
    && roster_version === recorded.roster_version && isDeepStrictEqual(current.inputs, offline.inputs);
  const verdict = alignedInputs ? (isDeepStrictEqual(liveEvaluation, offline.result) ? 'aligned' : 'evaluation_mismatch') : 'inputs_not_aligned';
  const comparableScope = current && offline && current.inputs.environment === offline.inputs.environment && current.inputs.project === offline.inputs.project;
  const liveConfirmed = !remote || (remote.inputs_aligned !== false && isDeepStrictEqual(liveEvaluation, current?.result));
  const candidates = entry && incident && current && comparableScope && !incomplete && liveConfirmed
    ? compareRecovery(incident, live, current.result, entry, options) : [];
  return {
    mode: backend.mode, request_id: randomUUID(), environment, flag, head_commit: head.sha, snapshots_replayed, transitions,
    timeline_message: incomplete ? 'timeline replay incomplete: snapshot or identity evaluation inputs are unavailable'
      : transitions.length === 0 ? 'no flag-config transition found' : null,
    snapshot_gap, snapshot_gap_reason: snapshot_gap ? 'external_drift_unrecorded' : null,
    parity: { verdict, live: liveEvaluation, offline: offline?.result ?? null }, candidates,
  };
}

export function formatDiagnosisReport(report: DiagnosisReport): string {
  return JSON.stringify(report, null, 2);
}
