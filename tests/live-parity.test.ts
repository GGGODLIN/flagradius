import { readFile, writeFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { createFlagEvaluator, evaluateTargetedBlastRadius } from '../src/evaluator.js';
import { FlagsmithAdapter } from '../src/flagsmith-adapter.js';
import type { FlagsmithAdapterOptions } from '../src/flagsmith-adapter.js';
import type { EnvironmentDocument, FeatureState, FlagWriteOperation } from '../src/types.js';

const flag = 'new_search';
const seedPath = 'parity-report/sandbox.json';

function stateSemantics(state: FeatureState) {
  return {
    enabled: state.enabled,
    value: state.feature_state_value,
    priority: state.feature_segment?.priority ?? null,
    nonzeroWeights: (state.multivariate_feature_state_values ?? [])
      .filter(variant => variant.percentage_allocation > 0)
      .map(variant => [variant.multivariate_feature_option.id, variant.percentage_allocation])
      .sort(([a], [b]) => a - b),
  };
}

function flagSemantics(doc: EnvironmentDocument) {
  const states = (values: FeatureState[]) => values.filter(s => s.feature.name === flag).map(stateSemantics);
  return {
    defaults: states(doc.feature_states),
    segments: doc.project.segments.flatMap(segment => states(segment.feature_states).map(state => [segment.id, state])),
    identities: (doc.identity_overrides ?? []).flatMap(identity => states(identity.identity_features).map(state => [identity.identifier, state])),
  };
}

describe.skipIf(process.env.RUN_LIVE_FLAGSMITH !== '1')('live self-hosted Flagsmith parity gate', () => {
  test('CLI v2 read-back and remote SDK agree with preview over the seeded roster', async () => {
    const { apiUrl, projectId, environmentKey, segmentId, variantIds, registeredIdentities } = JSON.parse(await readFile(seedPath, 'utf8')) as
      Pick<FlagsmithAdapterOptions, 'apiUrl' | 'projectId' | 'environmentKey'> & { segmentId: number; variantIds: [number, number]; registeredIdentities: number };
    const apiToken = process.env.FLAGSMITH_API_TOKEN;
    if (!apiToken) throw new Error('Missing disposable sandbox credential');
    const adapter = new FlagsmithAdapter({ apiUrl, projectId, environmentKey, apiToken });
    const { Flagsmith } = await import('@flagsmith/nodejs');
    const client = new Flagsmith({ apiUrl, environmentKey, retries: 0, requestTimeoutSeconds: 10 });
    const { generateRoster } = await import('../src/roster.js');
    const roster = generateRoster();
    expect(registeredIdentities).toBe(2000);
    expect(roster.filter(user => user.traits.cohort === 'internal_testers')).toHaveLength(12);
    expect(roster.filter(user => user.vip)).toHaveLength(5);
    const witnesses = [
      roster.find(user => user.identifier === 'standard-0001')!,
      roster.find(user => user.identifier === 'qa-01')!,
      roster.find(user => user.identifier === 'qa-12')!,
      roster.find(user => user.identifier === 'vip-acme-042')!,
    ];
    let before = await adapter.fetchEnvironmentDocument();
    const snapshots: Record<string, EnvironmentDocument> = {};
    const checks: Record<string, { matched: number; total: number }> = {};
    const cases: { key: string; op: FlagWriteOperation; enabled: boolean[]; values?: string[] }[] = [
      { key: 'environment-default', op: { type: 'set_environment_default', flag_name: flag, enabled: true }, enabled: [true, true, true, true] },
      { key: 'segment-override', op: { type: 'set_segment_override', flag_name: flag, segment_id: segmentId, enabled: false, value: 'qa' }, enabled: [true, false, false, true] },
      { key: 'segment-update', op: { type: 'set_segment_override', flag_name: flag, segment_id: segmentId, enabled: true }, enabled: [true, true, true, true], values: ['control', 'qa', 'qa', 'control'] },
      { key: 'identity-override', op: { type: 'set_identity_override', flag_name: flag, identifier: 'vip-acme-042', enabled: false }, enabled: [true, true, true, false] },
      { key: 'delete-segment', op: { type: 'delete_segment_override', flag_name: flag, segment_id: segmentId }, enabled: [true, true, true, false], values: ['control', 'control', 'control', 'control'] },
      { key: 'delete-identity', op: { type: 'delete_identity_override', flag_name: flag, identifier: 'vip-acme-042' }, enabled: [true, true, true, true] },
      { key: 'multivariate-weight', op: { type: 'set_multivariate_weights', flag_name: flag, weights: { [variantIds[0]]: 45, [variantIds[1]]: 40 } }, enabled: [true, true, true, true] },
    ];
    expect(flagSemantics(before).defaults).toEqual([{ enabled: false, value: 'control', priority: null, nonzeroWeights: [] }]);
    for (const { key, op, enabled, values } of cases) {
      const preview = adapter.applyOperationToDocument(before, op);
      await adapter.execute(op);
      const after = await adapter.fetchCliEnvironmentDocument();
      expect(flagSemantics(after), key).toEqual(flagSemantics(preview));
      const actualEval = createFlagEvaluator(after, flag);
      const previewEval = createFlagEvaluator(preview, flag);
      const aligned = roster.filter(user => {
        const actual = actualEval(user);
        const prediction = previewEval(user);
        return actual.enabled === prediction.enabled && actual.value === prediction.value;
      });
      expect(aligned.length, `${key}: preview vs read-back`).toBe(roster.length);
      expect(evaluateTargetedBlastRadius(before, after, flag, roster)).toEqual(evaluateTargetedBlastRadius(before, preview, flag, roster));
      const sample = key === 'multivariate-weight' ? [...witnesses, ...roster.filter(u => u.traits.cohort === 'standard').slice(1, 65)] : witnesses;
      const remote = await Promise.all(sample.map(async user => {
        const flags = await client.getIdentityFlags(user.identifier, undefined, true);
        return { enabled: flags.isFeatureEnabled(flag), value: flags.getFeatureValue(flag) };
      }));
      expect(remote.slice(0, enabled.length).map(result => result.enabled), key).toEqual(enabled);
      if (values) expect(remote.map(result => result.value), key).toEqual(values);
      if (key === 'multivariate-weight') expect([...new Set(remote.map(result => result.value))].sort()).toEqual(['a', 'b', 'control']);
      const matched = remote.filter((actual, i) => {
        const offline = actualEval(sample[i]);
        return offline.enabled === actual.enabled && offline.value === actual.value;
      }).length;
      checks[key] = { matched, total: sample.length };
      console.log(JSON.stringify({ mode: 'LIVE_FLAGSMITH', stage: key, live_vs_offline: checks[key], preview_vs_readback: aligned.length }));
      expect(matched, `${key}: live SDK vs offline`).toBe(sample.length);
      snapshots[key] = {
        ...after, api_key: '[redacted]',
        identity_overrides: after.identity_overrides?.map(identity => ({ ...identity, environment_api_key: '[redacted]' })),
      };
      await writeFile('parity-report/read-back.json', JSON.stringify(snapshots, null, 2));
      before = after;
    }
  }, 180_000);
});
