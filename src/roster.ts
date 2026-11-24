import type { RosterEntry } from './types.js';

function cohort(prefix: string, count: number, width: number, name: string, vip = false): RosterEntry[] {
  return Array.from({ length: count }, (_, i) => ({
    identifier: `${prefix}-${String(i + 1).padStart(width, '0')}`,
    traits: { cohort: name }, vip,
  }));
}

export function generateRoster(): RosterEntry[] {
  return [
    ...cohort('standard', 1983, 4, 'standard'),
    ...cohort('qa', 12, 2, 'internal_testers'),
    { identifier: 'vip-acme-042', traits: { cohort: 'vip' }, vip: true },
    ...cohort('vip', 4, 2, 'vip', true),
  ];
}
