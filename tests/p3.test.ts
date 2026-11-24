import fc from 'fast-check';
import { expect, test } from 'vitest';
import { createFlagEvaluator, evaluateTargetedBlastRadius } from '../src/evaluator.js';
import { FlagsmithAdapter } from '../src/flagsmith-adapter.js';
import type { BlastRadiusResult, EnvironmentDocument, FeatureState, FlagValue, FlagWriteOperation, RosterEntry } from '../src/types.js';
import { document, flag, roster, rule } from './fixtures.js';

const adapter = new FlagsmithAdapter({ apiUrl: 'http://127.0.0.1:1', projectId: 8, environmentKey: 'synthetic-env-key', apiToken: 'synthetic.test-key' });
const bitRow = fc.array(fc.option(fc.boolean(), { nil: null }), { minLength: 10, maxLength: 10 });
const scenarios = fc.record({
  defaults: fc.array(fc.boolean(), { minLength: 1, maxLength: 10 }),
  segments: fc.array(bitRow, { maxLength: 4 }), identities: fc.array(bitRow, { maxLength: 5 }),
  people: fc.array(fc.record({
    vip: fc.boolean(), membership: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
  }), { minLength: 1, maxLength: 100 }),
  selection: fc.nat(), action: fc.integer({ min: 0, max: 5 }), enabled: fc.boolean(),
  value: fc.oneof(fc.string(), fc.integer(), fc.boolean()),
  variant: fc.constantFrom(0, 1, 2),
});

function scenario(input: typeof scenarios extends fc.Arbitrary<infer T> ? T : never) {
  const before = document();
  const mkState = (i: number, enabled: boolean, offset = 0): FeatureState => ({
    feature: { id: i + 1, name: `flag_${i}`, type: 'MULTIVARIATE' },
    django_id: 100 + i + offset, feature_state_value: 'control', enabled,
  });
  before.feature_states = input.defaults.map((enabled, i) => ({ ...mkState(i, enabled), multivariate_feature_state_values: [
    { id: 1, multivariate_feature_option: { id: 1, value: 'A' }, percentage_allocation: 0 },
    { id: 2, multivariate_feature_option: { id: 2, value: 'B' }, percentage_allocation: 0 },
  ] }));
  const states = (row: (boolean | null)[], offset: number) => row.slice(0, input.defaults.length).flatMap((enabled, i) => enabled === null ? [] : [mkState(i, enabled, offset)]);
  before.project.segments = input.segments.map((row, i) => ({
    id: i + 1, name: `segment_${i}`, rules: [rule(`segment_${i}`, 'yes')],
    feature_states: states(row, (i + 1) * 100).map(state => ({ ...state, feature_segment: { priority: i } })),
  }));
  before.identity_overrides = input.identities.slice(0, input.people.length).map((row, i) => ({
    identifier: `person_${i}`, identity_features: states(row, (i + 5) * 100),
  }));
  const users: RosterEntry[] = input.people.map(({ vip, membership }, i) => ({
    identifier: `person_${i}`, vip,
    traits: Object.fromEntries(membership.map((yes, n) => [`segment_${n}`, yes ? 'yes' : 'no'])),
  }));
  const selected = input.selection % input.defaults.length;
  const flag_name = `flag_${selected}`;
  const segment = before.project.segments.find(segment => segment.feature_states.some(state => state.feature.name === flag_name));
  const identity = before.identity_overrides.find(identity => identity.identity_features.some(state => state.feature.name === flag_name));
  const defaultOp = { type: 'set_environment_default', flag_name, enabled: input.enabled, value: input.value } as const;
  const operations: FlagWriteOperation[] = [
    defaultOp,
    before.project.segments.length ? { type: 'set_segment_override', flag_name, segment_id: before.project.segments[0].id, enabled: input.enabled } : defaultOp,
    segment ? { type: 'delete_segment_override', flag_name, segment_id: segment.id } : defaultOp,
    { type: 'set_identity_override', flag_name, identifier: users[0].identifier, enabled: input.enabled },
    identity ? { type: 'delete_identity_override', flag_name, identifier: identity.identifier } : defaultOp,
    { type: 'set_multivariate_weights', flag_name, weights: { 1: input.variant === 1 ? 100 : 0, 2: input.variant === 2 ? 100 : 0 } },
  ];
  const operation = operations[input.action];
  return { before, after: adapter.applyOperationToDocument(before, operation), name: flag_name, users, operation };
}

// The generated 0/100 allocations make the expected value independent of the SDK's bucketing algorithm.
function bruteFlagMap(doc: EnvironmentDocument, user: RosterEntry): Map<string, { enabled: boolean; value: FlagValue }> {
  const all = new Map(doc.feature_states.map(state => [state.feature.name, state]));
  const candidates = doc.project.segments.filter(segment => user.traits[segment.name] === 'yes')
    .flatMap(segment => segment.feature_states).sort((a, b) => b.feature_segment!.priority - a.feature_segment!.priority);
  for (const state of candidates) all.set(state.feature.name, state);
  for (const state of doc.identity_overrides?.find(identity => identity.identifier === user.identifier)?.identity_features ?? []) {
    all.set(state.feature.name, state);
  }
  return new Map([...all].map(([name, state]) => {
    const variant = state.multivariate_feature_state_values?.find(option => option.percentage_allocation === 100);
    return [name, { enabled: state.enabled, value: variant ? variant.multivariate_feature_option.value : state.feature_state_value }];
  }));
}

function bruteFlips(before: EnvironmentDocument, after: EnvironmentDocument, name: string, users: readonly RosterEntry[]): BlastRadiusResult {
  const transitions = users.map(user => ({ user, previous: bruteFlagMap(before, user).get(name)!, next: bruteFlagMap(after, user).get(name)! }));
  const enabled = transitions.filter(({ previous, next }) => !previous.enabled && next.enabled);
  const disabled = transitions.filter(({ previous, next }) => previous.enabled && !next.enabled);
  const valueChanges = transitions.filter(({ previous, next }) => previous.enabled === next.enabled && previous.value !== next.value);
  const changed = [...enabled, ...disabled, ...valueChanges];
  return {
    total_evaluated: users.length, total_flipped: changed.length,
    flipped_on: enabled.length, flipped_off: disabled.length, value_changed: valueChanges.length,
    vip_hits: changed.filter(({ user }) => user.vip).length,
  };
}

function p3(actual: BlastRadiusResult, expected: BlastRadiusResult, population: number) {
  return {
    nonNegative: actual.flipped_on >= 0 && actual.flipped_off >= 0 && actual.value_changed >= 0,
    conservation: actual.flipped_on + actual.flipped_off + actual.value_changed === actual.total_flipped && actual.total_flipped <= population,
    vipBounds: actual.vip_hits >= 0 && actual.vip_hits <= actual.total_flipped,
    exactTransitions: Object.entries(expected).every(([key, value]) => actual[key as keyof BlastRadiusResult] === value),
  };
}

test('P3 conserves counts and excludes unchanged identities against a brute-force full-document oracle', () => {
  const reachedValueOnly = new Set<FlagWriteOperation['type']>();
  fc.assert(fc.property(scenarios, input => {
    const { before, after, name, users, operation } = scenario(input);
    const counts = evaluateTargetedBlastRadius(before, after, name, users);
    const expected = bruteFlips(before, after, name, users);
    if (!Object.values(p3(counts, expected, users.length)).every(Boolean)) return false;
    if (expected.value_changed > 0) reachedValueOnly.add(operation.type);
    return [before, after].every(doc => {
      const targeted = createFlagEvaluator(doc, name);
      return users.every(user => {
        const actual = targeted(user);
        const reference = bruteFlagMap(doc, user).get(name)!;
        return actual.enabled === reference.enabled && actual.value === reference.value;
      });
    });
  }), { numRuns: 250, seed: 20261124 });
  expect(reachedValueOnly).toContain('set_environment_default');
  expect(reachedValueOnly).toContain('set_multivariate_weights');
});

test('calibrates each P3 predicate on a local mutated control', () => {
  const before = document();
  const after = document();
  after.identity_overrides = [
    { identifier: 'qa-01', identity_features: [{ ...after.feature_states[0], enabled: true }] },
    { identifier: 'vip-acme-042', identity_features: [{ ...after.feature_states[0], feature_state_value: 'updated' }] },
  ];
  const expected = bruteFlips(before, after, flag, roster);
  expect(expected).toEqual({ total_evaluated: 3, total_flipped: 2, flipped_on: 1, flipped_off: 0, value_changed: 1, vip_hits: 1 });
  const actual = evaluateTargetedBlastRadius(before, after, flag, roster);
  expect(p3(actual, expected, 3)).toEqual({ nonNegative: true, conservation: true, vipBounds: true, exactTransitions: true });
  expect(p3({ ...actual, value_changed: -1 }, expected, 3).nonNegative).toBe(false);
  expect(p3({ ...actual, total_flipped: actual.flipped_on + actual.flipped_off }, expected, 3).conservation).toBe(false);
  expect(p3({ ...actual, vip_hits: 3 }, expected, 3).vipBounds).toBe(false);
  const includesUnchanged = { ...actual, value_changed: 2, total_flipped: 3 };
  const omitsValueChanges = { ...actual, value_changed: 0, total_flipped: 1, vip_hits: 0 };
  for (const mutant of [includesUnchanged, omitsValueChanges]) {
    expect(p3(mutant, expected, 3)).toEqual({ nonNegative: true, conservation: true, vipBounds: true, exactTransitions: false });
  }
});
