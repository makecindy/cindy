// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import type { PrStatusResult } from '@/lib/gitContext.types';
import { fillGhostCardPrStatus, readPrStatusSlotKey } from '../ghostCardPrStatus';

// Unit: the PR card's check strip was a snapshot from the agent's last pr_card call and could
// say "CI running" long after the title bar showed it passed. GhostToolCard now fills the
// plugin's slot from the same status the title bar polls; the plugin's snapshot stays only
// as the fallback when the host has nothing for that PR.
describe('fillGhostCardPrStatus', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    key.split('.').at(-1)! + (options?.count !== undefined ? `:${options.count}` : '');
  const status = (extra: Partial<Extract<PrStatusResult, { ok: true }>> = {}): PrStatusResult => ({
    ok: true, owner: 'octo', repo: 'repo', prNumber: 9, status: 'open', title: 'T', htmlUrl: '', branch: 'b',
    unresolvedCount: 2, checks: { total: 3, passed: 3, failed: 0, pending: 0, skipped: 0 },
    mergeState: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', ...extra,
  });
  const card = () => {
    document.body.innerHTML = '<div data-ghost-pr-status="Octo/Repo#9"><div>snapshot</div></div>';
    return document.querySelector('div')!;
  };

  it('replaces the snapshot with the title bar status for the same PR', () => {
    expect(readPrStatusSlotKey(' <div data-ghost-pr-status="Octo/Repo#9">')).toBe('octo/repo#9');
    const slot = card();
    const seen: string[] = [];
    fillGhostCardPrStatus(document, (key) => { seen.push(key); return status(); }, t);
    expect(seen).toEqual(['octo/repo#9']);
    expect(slot.textContent).toBe('ciPassedthreadsOpen:2mergeApproval');
    // Polling refreshes the same document in place.
    fillGhostCardPrStatus(document, () => status({ checks: { total: 3, passed: 2, failed: 1, pending: 0, skipped: 0 }, mergeState: 'DIRTY' }), t);
    expect(slot.textContent).toBe('ciFailedthreadsOpen:2mergeConflict');
  });

  it('keeps the snapshot when the host has no usable status, and never guesses merge state for older hosts', () => {
    const slot = card();
    fillGhostCardPrStatus(document, () => undefined, t);
    fillGhostCardPrStatus(document, () => ({ ok: false, owner: 'octo', repo: 'repo', prNumber: 9, reason: 'no-token' }), t);
    expect(slot.textContent).toBe('snapshot');
    const legacy = status({ unresolvedCount: 0 });
    delete (legacy as { mergeState?: unknown }).mergeState;
    delete (legacy as { reviewDecision?: unknown }).reviewDecision;
    fillGhostCardPrStatus(document, () => legacy, t);
    expect(slot.textContent).toBe('ciPassedthreadsNone');
  });
});
