import type { ApprovalCard } from './guard-engine.js';
import type { ModeTag } from './types.js';

const entities: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string | number) => String(value).replace(/[&<>"']/g, character => entities[character]);

interface ApprovalPage {
  path: string;
  mode: ModeTag;
  state: { status: 'locked' }
    | { status: 'pending'; card: ApprovalCard; segmentName?: string; token: string }
    | { status: 'terminal'; result: string; code?: string };
}

const outcomes: Record<string, string> = {
  snapshotted: 'The flag change was verified and recorded.',
  already_approved: 'This approval has already been used.',
  rejected: 'The flag change was rejected.',
  stale_approval: 'The baseline changed. Submit a new proposal to review the updated impact.',
  write_unconfirmed: 'The write could not be verified. Reconcile the environment before proposing another change.',
};

function renderContent(path: string, state: ApprovalPage['state']): string {
  if (state.status === 'locked') return `
    <form method="post" action="${escapeHtml(path)}">
      <label for="operator-token">Operator token</label>
      <input id="operator-token" type="password" name="token" autocomplete="off" required>
      <button>Open approval card</button>
    </form>`;
  if (state.status === 'terminal') return `
    <p class="outcome" role="status">${escapeHtml(state.result)}</p>
    <p>${escapeHtml(outcomes[state.result] ?? state.code ?? 'The decision could not be processed.')}</p>`;

  const { card, segmentName, token } = state;
  const impact = card.blast_radius;
  const scope = card.segment_id !== undefined ? `Segment #${card.segment_id}${segmentName ? ` · ${segmentName}` : ''}`
    : card.identifier !== undefined ? `Identity · ${card.identifier}` : 'Environment default';
  const fields = [
    ['Environment', card.environment], ['Flag', card.flag_name], ['Target', scope], ['Operation', card.target],
    ['Evaluated roster', impact.total_evaluated], ['VIP hits', impact.vip_hits],
    ['Trigger reason', card.reasons.join(', ')], ['Baseline revision', card.baseline_revision],
  ];
  return `
    <dl>${fields.map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
    <ul class="impact" aria-label="Flag impact">
      <li class="on">+ON ${impact.flipped_on}</li>
      <li class="off">-OFF ${impact.flipped_off}</li>
      <li>~value_changed ${impact.value_changed}</li>
    </ul>
    <div class="actions">
      <form method="post" action="${escapeHtml(path)}/approve">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button>Approve</button>
      </form>
      <form method="post" action="${escapeHtml(path)}/reject">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button class="secondary">Reject</button>
      </form>
    </div>`;
}

export function renderApprovalPage({ path, mode, state }: ApprovalPage): string {
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Impact Approval Card</title>
<style>
  :root { color-scheme: light; font: 100%/1.5 system-ui, sans-serif; color: #182421; background: #f3f6f4; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: clamp(1rem, 5vw, 3rem); }
  main { max-width: 44rem; margin: auto; padding: clamp(1rem, 4vw, 2rem); background: white; border: 1px solid #cbd5cf;
    border-radius: 1rem; overflow-wrap: anywhere; word-break: break-word; }
  header { border-bottom: 1px solid #dde3df; padding-bottom: 1rem; }
  h1 { font-size: clamp(1.5rem, 4vw, 2rem); line-height: 1.2; margin: 0 0 .6rem; }
  .mode, .outcome { font-family: ui-monospace, monospace; font-weight: 700; }
  .mode { display: inline-block; color: #1b5145; background: #e4f2eb; border-radius: .35rem; padding: .2rem .5rem; }
  dl { margin: 1rem 0; }
  dl > div { display: grid; grid-template-columns: minmax(0, 9rem) minmax(0, 1fr); gap: .5rem; padding: .3rem 0; }
  dt { color: #41554d; }
  dd { margin: 0; font-weight: 600; }
  .impact, .actions { display: flex; flex-wrap: wrap; gap: .55rem; padding: 0; }
  .impact { list-style: none; margin: 1.1rem 0; }
  .impact li { background: #edf0ee; border-radius: .35rem; padding: .25rem .5rem; }
  .impact .on { background: #e4f2eb; color: #135742; }
  .impact .off { background: #fcebe8; color: #772f27; }
  main > form { display: grid; gap: .55rem; margin-top: 1rem; }
  input, button { font: inherit; padding: .55rem .8rem; border: 1px solid #1b5145; border-radius: .4rem; }
  button { background: #1b5145; color: white; font-weight: 700; cursor: pointer; }
  button.secondary { background: white; color: #772f27; border-color: #772f27; }
  :focus-visible { outline: 3px solid #006bb3; outline-offset: 2px; }
  @media (max-width: 28rem) { dl > div { grid-template-columns: minmax(0, 1fr); gap: 0; } }
</style>
<main>
  <header><h1>Impact Approval Card</h1><span class="mode">${escapeHtml(mode)}</span></header>
  ${renderContent(path, state)}
</main>
</html>`;
}
