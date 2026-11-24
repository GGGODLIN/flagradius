export type FlagValue = string | number | boolean | null;
export type ModeTag = 'LIVE_FLAGSMITH' | 'OFFLINE_FIXTURE_REPLAY';

export interface FeatureState {
  feature: { id: number; name: string; type: 'STANDARD' | 'MULTIVARIATE' };
  enabled: boolean;
  django_id?: number | null;
  featurestate_uuid?: string;
  feature_state_value: FlagValue;
  feature_segment?: { priority: number } | null;
  multivariate_feature_state_values?: VariantState[];
  metadata?: unknown;
}

export interface VariantState {
  id?: number | null;
  mv_fs_value_uuid?: string;
  multivariate_feature_option: { id: number; value: FlagValue; key?: string | null };
  percentage_allocation: number;
}

export interface SegmentRule {
  type: 'ALL' | 'ANY' | 'NONE';
  conditions: { operator: string; property_: string | null; value: string | null }[];
  rules: SegmentRule[];
}

export interface IdentityOverride {
  identifier: string;
  environment_api_key?: string;
  identity_uuid?: string;
  django_id?: number | null;
  created_date?: string;
  identity_traits?: { trait_key: string; trait_value: FlagValue }[];
  identity_features: FeatureState[];
}

export interface EnvironmentDocument {
  id: number;
  api_key: string;
  name: string;
  project: {
    id: number;
    name: string;
    hide_disabled_flags?: boolean;
    organisation: { id: number; name: string; feature_analytics?: boolean; stop_serving_flags?: boolean; persist_trait_data?: boolean };
    segments: { id: number; name: string; rules: SegmentRule[]; feature_states: FeatureState[] }[];
  };
  feature_states: FeatureState[];
  identity_overrides?: IdentityOverride[];
}

export interface RosterEntry {
  identifier: string;
  traits: Record<string, FlagValue>;
  vip: boolean;
}

type FlagPatch = { enabled: boolean; value?: Exclude<FlagValue, null> } | { enabled?: boolean; value: Exclude<FlagValue, null> };
export type FlagWriteOperation = { flag_name: string } & (
  | ({ type: 'set_environment_default' } & FlagPatch)
  | ({ type: 'set_segment_override'; segment_id: number } & FlagPatch)
  | { type: 'delete_segment_override'; segment_id: number }
  | ({ type: 'set_identity_override'; identifier: string } & FlagPatch)
  | { type: 'delete_identity_override'; identifier: string }
  | { type: 'set_multivariate_weights'; weights: Readonly<Record<number, number>> }
);

export interface BlastRadiusResult {
  total_evaluated: number;
  total_flipped: number;
  flipped_on: number;
  flipped_off: number;
  value_changed: number;
  vip_hits: number;
}

export class FlagsmithError extends Error {
  constructor(readonly mode: ModeTag, readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'FlagsmithError';
  }
}
