import type { EnvironmentModel, IdentityModel } from '@flagsmith/nodejs';
import { FlagsmithError } from './types.js';
import type { BlastRadiusResult, EnvironmentDocument, FeatureState, FlagValue, RosterEntry, SegmentRule } from './types.js';

interface EngineContext {
  identity?: { identifier: string; traits: Record<string, FlagValue> };
}

type FlagEvaluation = { enabled: boolean; value: FlagValue };

// The pinned SDK only exports its package root. Resolve adjacent ESM files via the installed entry, not the caller's cwd.
const sdkEntry = import.meta.resolve('@flagsmith/nodejs');
const [environment, identity, mapper, engine] = await Promise.all([
  import(new URL('./flagsmith-engine/environments/util.js', sdkEntry).href),
  import(new URL('./flagsmith-engine/identities/util.js', sdkEntry).href),
  import(new URL('./flagsmith-engine/evaluation/evaluationContext/mappers.js', sdkEntry).href),
  import(new URL('./flagsmith-engine/index.js', sdkEntry).href),
]);
const buildEnvironmentModel = environment.buildEnvironmentModel as (doc: EnvironmentDocument) => EnvironmentModel;
const buildIdentityModel = identity.buildIdentityModel as (override: NonNullable<EnvironmentDocument['identity_overrides']>[number]) => IdentityModel;
const getEvaluationContext = mapper.getEvaluationContext as (environment: EnvironmentModel) => EngineContext;
const getEvaluationResult = engine.getEvaluationResult as (context: EngineContext) => { flags: Record<string, FlagEvaluation> };

function invalidDocument(): FlagsmithError {
  return new FlagsmithError('OFFLINE_FIXTURE_REPLAY', 'INVALID_DOCUMENT', 'The environment document cannot be evaluated for the requested flag.');
}

function readsOtherFlags(rule: SegmentRule): boolean {
  return rule.conditions.some(({ property_ }) => /^\$\.flags(?:\.|\[|$)/.test(property_ ?? '')) || rule.rules.some(readsOtherFlags);
}

function normalizeState(state: FeatureState, scopeKey: string): FeatureState {
  // Prevent flagsmith-engine from minting random UUIDs when fixtures omit both django_id and featurestate_uuid.
  const stableUuid = state.django_id != null || state.featurestate_uuid
    ? state.featurestate_uuid
    : `stable:${scopeKey}:${state.feature.id}:${state.feature.name}`;
  return {
    ...state,
    ...(stableUuid !== undefined ? { featurestate_uuid: stableUuid } : {}),
    multivariate_feature_state_values: state.multivariate_feature_state_values ?? [],
  };
}

export function createFlagEvaluator(doc: EnvironmentDocument, flagName: string): (entry: RosterEntry) => FlagEvaluation {
  // The SDK indexes flags in ordinary objects. Prototype-like trait names remain supported via a separate map.
  if (Object.hasOwn(Object.prototype, flagName)) throw invalidDocument();
  const isTarget = (state: FeatureState) => state.feature.name === flagName;
  try {
    const defaults = doc.feature_states.filter(isTarget).map(state => normalizeState(state, 'env'));
    if (defaults.length !== 1 || typeof defaults[0].enabled !== 'boolean') throw invalidDocument();
    const segments = doc.project.segments.flatMap(segment => {
      const states = segment.feature_states.filter(isTarget).map(state => normalizeState(state, `seg:${segment.id}`));
      if (states.length === 0) return [];
      if (segment.rules.some(readsOtherFlags)) {
        throw new FlagsmithError('OFFLINE_FIXTURE_REPLAY', 'UNSUPPORTED_FLAG_DEPENDENCY', 'The target segment depends on another flag; single-flag evaluation cannot verify it.');
      }
      return [{ ...segment, feature_states: states }];
    });
    const project = { ...doc.project, segments };
    const model = buildEnvironmentModel({ ...doc, project, feature_states: defaults, identity_overrides: [] });
    const base = getEvaluationContext(model);
    // LocalFileHandler does not populate the SDK's identity index. Exact Map lookup also avoids the engine's comma-delimited identity grouping.
    const overrides = new Map((doc.identity_overrides ?? []).map(raw => {
      const featureStates = raw.identity_features.filter(isTarget).map(state => normalizeState(state, `id:${raw.identifier}`));
      const hydrated = buildIdentityModel({ ...raw, identity_features: featureStates });
      const overridden = featureStates.length === 0 ? base : getEvaluationContext({
        ...model, project: { ...model.project, segments: [] }, featureStates: hydrated.identityFeatures,
      });
      return [hydrated.identifier, { context: overridden, traits: hydrated.identityTraits }];
    }));

    return (entry) => {
      const matching = overrides.get(entry.identifier);
      const traits: Record<string, FlagValue> = Object.create(null);
      for (const trait of matching?.traits ?? []) traits[trait.traitKey] = trait.traitValue;
      for (const [key, value] of Object.entries(entry.traits)) {
        if (value === null) delete traits[key];
        else traits[key] = value;
      }
      try {
        const { flags } = getEvaluationResult({ ...(matching?.context ?? base), identity: { identifier: entry.identifier, traits } });
        const result = Object.hasOwn(flags, flagName) ? flags[flagName] : undefined;
        if (!result || typeof result.enabled !== 'boolean') throw invalidDocument();
        return { enabled: result.enabled, value: result.value };
      } catch {
        throw invalidDocument();
      }
    };
  } catch (error) {
    if (error instanceof FlagsmithError) throw error;
    throw invalidDocument();
  }
}

export function evaluateTargetedBlastRadius(beforeDoc: EnvironmentDocument, afterDoc: EnvironmentDocument, flagName: string, roster: readonly RosterEntry[]): BlastRadiusResult {
  const before = createFlagEvaluator(beforeDoc, flagName);
  const after = createFlagEvaluator(afterDoc, flagName);
  let flipped_on = 0;
  let flipped_off = 0;
  let value_changed = 0;
  let vip_hits = 0;
  for (const entry of roster) {
    const previous = before(entry);
    const next = after(entry);
    if (previous.enabled !== next.enabled) {
      if (next.enabled) flipped_on++;
      else flipped_off++;
    } else if (previous.value !== next.value) {
      value_changed++;
    } else {
      continue;
    }
    if (entry.vip) vip_hits++;
  }
  return { total_evaluated: roster.length, total_flipped: flipped_on + flipped_off + value_changed, flipped_on, flipped_off, value_changed, vip_hits };
}
