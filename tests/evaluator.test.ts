import { expect, test } from 'vitest';
import { createFlagEvaluator, evaluateTargetedBlastRadius } from '../src/evaluator.js';
import { FlagsmithAdapter } from '../src/flagsmith-adapter.js';
import { generateRoster } from '../src/roster.js';
import { document, flag, roster, rule, state } from './fixtures.js';

test('counts defaults, segment overrides and an identity override over the same segment', () => {
  const before = document();
  before.project.segments.push({ id: 2, name: 'internal_testers', rules: [rule('cohort', 'internal_testers')], feature_states: [state(true, { feature_segment: { priority: 0 } })] });
  before.identity_overrides = [{ identifier: 'vip-acme-042', identity_features: [state(false)] }];
  const after = document(true);
  after.feature_states[0].feature_state_value = 'updated';
  expect(evaluateTargetedBlastRadius(before, after, flag, roster)).toEqual({
    total_evaluated: 3, total_flipped: 3, flipped_on: 2, flipped_off: 0, value_changed: 1, vip_hits: 1,
  });
});

test.each(['toString', '__proto__'])('matches only explicitly supplied prototype-like trait %s', (key) => {
  const before = document();
  const after = document();
  after.project.segments.push({
    id: 2, name: 'explicit', rules: [{ type: 'ALL', rules: [], conditions: [{ operator: 'IS_SET', property_: key, value: null }] }],
    feature_states: [state(true, { feature_segment: { priority: 0 } })],
  });
  const users = [{ ...roster[0], traits: {} }, { ...roster[2], traits: { [key]: 'yes' } }];
  expect(evaluateTargetedBlastRadius(before, after, flag, users)).toEqual({
    total_evaluated: 2, total_flipped: 1, flipped_on: 1, flipped_off: 0, value_changed: 0, vip_hits: 1,
  });
});

const adapter = new FlagsmithAdapter({ apiUrl: 'http://127.0.0.1:1', projectId: 8, environmentKey: 'synthetic-env-key', apiToken: 'synthetic.test-key' });
const vip = roster.filter(user => user.vip);

test('counts a VIP default value change without a second enabled flip', () => {
  const before = document(true);
  before.feature_states[0].feature_state_value = 'v1';
  const after = adapter.applyOperationToDocument(before, { type: 'set_environment_default', flag_name: flag, value: 'v2' });
  expect(evaluateTargetedBlastRadius(before, after, flag, vip)).toEqual({
    total_evaluated: 1, total_flipped: 1, flipped_on: 0, flipped_off: 0, value_changed: 1, vip_hits: 1,
  });
});

test('counts a VIP moving from B to A when only multivariate weights change', () => {
  const before = document(true);
  before.feature_states[0].multivariate_feature_state_values = [
    { id: 1, percentage_allocation: 0, multivariate_feature_option: { id: 4, value: 'A' } },
    { id: 2, percentage_allocation: 100, multivariate_feature_option: { id: 5, value: 'B' } },
  ];
  const after = adapter.applyOperationToDocument(before, { type: 'set_multivariate_weights', flag_name: flag, weights: { 4: 100, 5: 0 } });
  expect(createFlagEvaluator(before, flag)(vip[0])).toEqual({ enabled: true, value: 'B' });
  expect(createFlagEvaluator(after, flag)(vip[0])).toEqual({ enabled: true, value: 'A' });
  expect(evaluateTargetedBlastRadius(before, after, flag, vip)).toEqual({
    total_evaluated: 1, total_flipped: 1, flipped_on: 0, flipped_off: 0, value_changed: 1, vip_hits: 1,
  });
});

test('reports zero flips deterministically for an identical 50/50 multivariate doc omitting django_id and featurestate_uuid', () => {
  const doc = document(true);
  delete doc.feature_states[0].django_id;
  delete doc.feature_states[0].featurestate_uuid;
  doc.feature_states[0].multivariate_feature_state_values = [
    { id: 21, mv_fs_value_uuid: '00000000-0000-4000-8000-000000000021', multivariate_feature_option: { id: 11, value: 'A' }, percentage_allocation: 50 },
    { id: 22, mv_fs_value_uuid: '00000000-0000-4000-8000-000000000022', multivariate_feature_option: { id: 12, value: 'B' }, percentage_allocation: 50 },
  ];
  for (let i = 0; i < 64; i += 1) {
    expect(evaluateTargetedBlastRadius(doc, doc, flag, vip)).toEqual({
      total_evaluated: 1, total_flipped: 0, flipped_on: 0, flipped_off: 0, value_changed: 0, vip_hits: 0,
    });
  }
});

test('rejects a missing target instead of reporting a zero blast radius', () => {
  const before = document();
  const invalid = document();
  invalid.feature_states = [];
  expect(() => evaluateTargetedBlastRadius(before, invalid, flag, roster))
    .toThrow(expect.objectContaining({ mode: 'OFFLINE_FIXTURE_REPLAY', code: 'INVALID_DOCUMENT' }));
});

test('generates the deterministic synthetic ticket roster', () => {
  const entries = generateRoster();
  expect(new Set(entries.map(({ identifier }) => identifier)).size).toBe(2000);
  expect(entries.filter(({ traits }) => traits.cohort === 'internal_testers').map(({ identifier }) => identifier))
    .toEqual(Array.from({ length: 12 }, (_, i) => `qa-${String(i + 1).padStart(2, '0')}`));
  expect(entries.filter(({ vip }) => vip)).toHaveLength(5);
  expect(entries.find(({ identifier }) => identifier === 'vip-acme-042')?.vip).toBe(true);
  expect(entries).toEqual(generateRoster());
});
