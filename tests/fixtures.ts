import type { EnvironmentDocument, FeatureState, RosterEntry, SegmentRule } from '../src/types.js';

export const flag = 'new_search';
export const feature: FeatureState['feature'] = { id: 1, name: flag, type: 'MULTIVARIATE' };
export const state = (enabled: boolean, extra: Partial<FeatureState> = {}): FeatureState => ({
  feature, enabled, django_id: 101, feature_state_value: 'control', ...extra,
});
export const rule = (property_: string, value: string): SegmentRule => ({
  type: 'ALL', rules: [], conditions: [{ operator: 'EQUAL', property_, value }],
});
export const document = (enabled = false): EnvironmentDocument => ({
  id: 1, api_key: 'synthetic-env-key', name: 'Sandbox',
  project: { id: 8, name: 'Sandbox', organisation: { id: 4, name: 'Sandbox' }, segments: [] },
  feature_states: [state(enabled)],
});
export const roster: RosterEntry[] = [
  { identifier: 'standard-01', vip: false, traits: { cohort: 'standard' } },
  { identifier: 'qa-01', vip: false, traits: { cohort: 'internal_testers' } },
  { identifier: 'vip-acme-042', vip: true, traits: { cohort: 'internal_testers' } },
];
