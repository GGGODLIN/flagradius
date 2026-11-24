import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { flag, state } from './fixtures.js';
import { environment, setup } from './guard-fixture.js';

type Policy = 'budget' | 'vip' | 'protected' | 'automatic';
type FlagState = { enabled: boolean; value: string };
type LedgerCard = { id: string; before: FlagState; proposed: boolean; disposition: 'open' | 'approved' | 'rejected' | 'stale' };

type Action =
  | { action: 'propose'; slot: number; enabled: boolean }
  | { action: 'human_approve' | 'human_reject'; slot: number }
  | { action: 'external_drift_edit'; enabled: boolean; value: string };

// The reference uses one identity and one default flag, so an enabled change flips exactly one
// identity. It knows nothing about the evaluator, receipt states, or the production transition table.
class ReferenceLedger {
  live: FlagState = { enabled: false, value: 'control' };
  readonly cards = new Map<number, LedgerCard>();
  readonly uses = new Map<string, number>();

  constructor(readonly policy: Policy) {}

  requiresApproval(proposed: boolean): boolean {
    switch (this.policy) {
      case 'protected': return true;
      case 'budget': case 'vip': return proposed !== this.live.enabled;
      case 'automatic': return false;
    }
  }

  presentCard(slot: number, id: string, proposed: boolean): void {
    this.cards.set(slot, { id, before: { ...this.live }, proposed, disposition: 'open' });
  }

  decide(card: LedgerCard | undefined, decision: 'approve' | 'reject'): boolean {
    if (!card || card.disposition !== 'open') return false;
    if (decision === 'reject') {
      card.disposition = 'rejected';
      return false;
    }
    const fresh = card.before.enabled === this.live.enabled && card.before.value === this.live.value;
    card.disposition = fresh ? 'approved' : 'stale';
    return fresh;
  }

  observeWrites(proposed: readonly boolean[], freshApproval: boolean, card?: LedgerCard, fromCard = false) {
    let P1 = true;
    for (const enabled of proposed) {
      if (this.requiresApproval(enabled) && (!freshApproval || enabled !== card?.proposed)) P1 = false;
    }
    if (card) this.uses.set(card.id, (this.uses.get(card.id) ?? 0) + proposed.length);
    const P2 = !fromCard || proposed.length === 0 || (freshApproval && !!card && this.uses.get(card.id) === 1);
    if (proposed.length > 0) this.live.enabled = proposed[proposed.length - 1];
    return { P1, P2 };
  }
}

const slot = fc.integer({ min: 0, max: 2 });
const actions: fc.Arbitrary<Action> = fc.oneof(
  fc.record({ action: fc.constant('propose' as const), slot, enabled: fc.boolean() }),
  fc.record({ action: fc.constant('human_approve' as const), slot }),
  fc.record({ action: fc.constant('human_reject' as const), slot }),
  fc.record({ action: fc.constant('external_drift_edit' as const), enabled: fc.boolean(), value: fc.constantFrom('control', 'external') }),
);

const configFor = (policy: Policy) => ({
  max_single_auto_flips: policy === 'budget' ? 0 : 1,
  roster: [{ identifier: 'model-witness', vip: policy === 'vip', traits: {} }],
  protected_flags: policy === 'protected' ? [flag] : [],
});

async function replay(policy: Policy, sequence: Action[]): Promise<boolean> {
  const { backend, engine, cleanup } = setup(configFor(policy));
  const ledger = new ReferenceLedger(policy);
  try {
    for (const step of sequence) {
      const writeIndex = backend.writes.length;
      let approved = false;
      let card: LedgerCard | undefined;
      if (step.action === 'external_drift_edit') {
        ledger.live = { enabled: step.enabled, value: step.value };
        backend.live.feature_states = [state(step.enabled, { feature_state_value: step.value })];
      } else if (step.action === 'propose') {
        const result = await engine.proposeChange({ environment, declared_intent: 'all',
          operation: { type: 'set_environment_default', flag_name: flag, enabled: step.enabled } });
        ledger.cards.delete(step.slot);
        if (result.status === 'pending_approval') ledger.presentCard(step.slot, result.card.id, step.enabled);
      } else {
        card = ledger.cards.get(step.slot);
        const id = card?.id ?? `absent-card-${step.slot}`;
        if (step.action === 'human_approve') {
          approved = ledger.decide(card, 'approve');
          await engine.approveCard(id);
        } else {
          ledger.decide(card, 'reject');
          await engine.rejectCard(id);
        }
      }
      const writes = backend.writes.slice(writeIndex);
      const proposed: boolean[] = [];
      for (const write of writes) {
        if (write.type !== 'set_environment_default' || write.flag_name !== flag || typeof write.enabled !== 'boolean') return false;
        proposed.push(write.enabled);
      }
      const fromCard = step.action === 'human_approve' || step.action === 'human_reject';
      const { P1, P2 } = ledger.observeWrites(proposed, approved, card, fromCard);
      if (!P1 || !P2) return false;
    }
    return true;
  } finally {
    cleanup();
  }
}

describe('Conditional PBT P1/P2', () => {
  it('checks both invariants after every action against the independent ledger', async () => {
    await fc.assert(fc.asyncProperty(fc.constantFrom<Policy>('budget', 'vip', 'protected', 'automatic'),
      fc.array(actions, { minLength: 1, maxLength: 24 }), replay), { numRuns: 40 });
  }, 30_000);

  it.each(['budget', 'vip', 'protected'] as const)('calibrates P1 against a %s bypass independently of P2', policy => {
    const valid = new ReferenceLedger(policy);
    valid.presentCard(0, 'approved', true);
    const card = valid.cards.get(0)!;
    expect(valid.observeWrites([true], valid.decide(card, 'approve'), card, true)).toEqual({ P1: true, P2: true });
    const bypass = new ReferenceLedger(policy);
    expect(bypass.observeWrites([true], false)).toEqual({ P1: false, P2: true });
  });

  it.each(['duplicate', 'rejected', 'stale'] as const)('calibrates P2 against a %s card write independently of P1', mutation => {
    const ledger = new ReferenceLedger('automatic');
    ledger.presentCard(0, 'card', true);
    const card = ledger.cards.get(0)!;
    if (mutation === 'duplicate') {
      expect(ledger.observeWrites([true], ledger.decide(card, 'approve'), card, true)).toEqual({ P1: true, P2: true });
    } else if (mutation === 'rejected') {
      ledger.decide(card, 'reject');
    } else {
      ledger.live.value = 'external';
    }
    const approved = ledger.decide(card, 'approve');
    expect(ledger.observeWrites([], approved, card, true)).toEqual({ P1: true, P2: true });
    expect(ledger.observeWrites([true], approved, card, true)).toEqual({ P1: true, P2: false });
  });
});
