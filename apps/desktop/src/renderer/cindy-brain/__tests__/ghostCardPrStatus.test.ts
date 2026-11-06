// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import type { PrStatusResult } from '@/lib/gitContext.types';
import { fillGhostCardPrStatus, fillGhostCardTaskAutoArchiveHint, readPrStatusSlotKey } from '../ghostCardPrStatus';

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
    expect(slot.textContent).toBe('3passedunresolved:2mergeApproval');
    // Polling refreshes the same document in place.
    fillGhostCardPrStatus(document, () => status({ checks: { total: 3, passed: 2, failed: 1, pending: 0, skipped: 0 }, mergeState: 'DIRTY' }), t);
    expect(slot.textContent).toBe('1failed2passedunresolved:2mergeConflict');
  });

  // Unit: the card said only "CI running" while the title bar's PR summary listed
  // 11 running / 9 passed / 1 skipped and 2 unresolved review threads. The card now
  // reads each non-zero check category with the summary's own labels and icons.
  it('lists each non-zero check category like the title bar PR summary', () => {
    const slot = card();
    fillGhostCardPrStatus(document, () => status({ checks: { total: 21, passed: 9, failed: 0, pending: 11, skipped: 1 } }), t);
    expect(slot.textContent).toBe('11pending9passed1skippedLabelunresolved:2mergeApproval');
    expect(slot.querySelectorAll('svg')).toHaveLength(3);
  });

  // Rule (2026-11-06): #90's card still said "following" with stop/settings buttons after the PR was
  // merged on GitHub, while the title bar said merged. Minimal input: one marked element with its own
  // inline display, through merged → unknown → closed (unit, jsdom).
  it('hides open-only parts once the same status says merged or closed, and restores them otherwise', () => {
    document.body.innerHTML = '<div data-ghost-pr-open-only="Octo/Repo#9" style="display:flex">actions</div>';
    const el = document.querySelector('div')!;
    expect(readPrStatusSlotKey(document.body.innerHTML)).toBe('octo/repo#9');
    fillGhostCardPrStatus(document, () => status(), t);
    expect(el.style.display).toBe('flex');
    fillGhostCardPrStatus(document, () => status({ status: 'merged' }), t);
    expect(el.style.display).toBe('none');
    fillGhostCardPrStatus(document, () => undefined, t);
    expect(el.style.display).toBe('flex');
    fillGhostCardPrStatus(document, () => status({ status: 'closed' }), t);
    expect(el.style.display).toBe('none');
  });

  // Rule (2026-11-06): the archive-task button shows once the PR ended. The host's own status wins
  // over the plugin snapshot; auto-archive is offered only for a PR the host itself saw merged.
  it('reveals the archive-task button for an ended PR and reports auto-archive only for a live merge', () => {
    document.body.innerHTML = '<button data-ghost-task-archive="Octo/Repo#9" data-ghost-task-archive-state="merged" data-ghost-task-archive-auto style="display:none"></button>';
    const el = document.querySelector('button')!;
    expect(readPrStatusSlotKey(document.body.innerHTML)).toBe('octo/repo#9');
    expect(fillGhostCardPrStatus(document, () => undefined, t)).toBe(false);
    expect(el.style.display).toBe('inline-flex');
    expect(fillGhostCardPrStatus(document, () => status(), t)).toBe(false);
    expect(el.style.display).toBe('none');
    expect(fillGhostCardPrStatus(document, () => status({ status: 'closed' }), t)).toBe(false);
    expect(el.style.display).toBe('inline-flex');
    expect(fillGhostCardPrStatus(document, () => status({ status: 'merged' }), t)).toBe(true);
    el.removeAttribute('data-ghost-task-archive-auto');
    expect(fillGhostCardPrStatus(document, () => status({ status: 'merged' }), t)).toBe(false);
  });

  // Rule (2026-11-06): while auto-archive is pending the card says so next to the revealed button and
  // offers a host-owned cancel; once it is no longer pending the hint goes away.
  it('shows the pending auto-archive hint with a cancel next to the revealed archive button', () => {
    document.body.innerHTML = '<div><button data-ghost-task-archive="Octo/Repo#9" data-ghost-task-archive-auto style="display:none"></button></div>';
    fillGhostCardPrStatus(document, () => status({ status: 'merged' }), t);
    const onCancel = vi.fn();
    const labels = { pending: 'Archives when you leave', cancel: 'Keep this time' };
    fillGhostCardTaskAutoArchiveHint(document, true, labels, onCancel);
    fillGhostCardTaskAutoArchiveHint(document, true, labels, onCancel);
    const hint = document.querySelectorAll('[data-x-auto-archive-hint]');
    expect(hint).toHaveLength(1);
    expect(hint[0].nextElementSibling?.hasAttribute('data-ghost-task-archive')).toBe(true);
    expect(hint[0].textContent).toBe('Archives when you leave · Keep this time');
    hint[0].querySelector('button')!.click();
    expect(onCancel).toHaveBeenCalledTimes(1);
    fillGhostCardTaskAutoArchiveHint(document, false, labels, onCancel);
    expect(document.querySelector('[data-x-auto-archive-hint]')).toBeNull();
  });

  it('puts the plugin snapshot back when the live status later disappears', () => {
    const slot = card();
    fillGhostCardPrStatus(document, () => status(), t);
    expect(slot.textContent).not.toBe('snapshot');
    fillGhostCardPrStatus(document, () => ({ ok: false, owner: 'octo', repo: 'repo', prNumber: 9, reason: 'not-found' }), t);
    expect(slot.textContent).toBe('snapshot');
    // It can be filled again afterwards, and restores again.
    fillGhostCardPrStatus(document, () => status(), t);
    expect(slot.textContent).not.toBe('snapshot');
    fillGhostCardPrStatus(document, () => undefined, t);
    expect(slot.textContent).toBe('snapshot');
  });

  it('fills every declared slot from its own PR, not only the first one', () => {
    document.body.innerHTML = '<div data-ghost-pr-status="Octo/Repo#9"><div>one</div></div><div data-ghost-pr-status="Octo/Repo#10"><div>two</div></div>';
    const [first, second] = Array.from(document.querySelectorAll('div[data-ghost-pr-status]'));
    const statuses = new Map([['octo/repo#9', status()], ['octo/repo#10', status({ unresolvedCount: 0, mergeState: 'CLEAN', reviewDecision: 'APPROVED' })]]);
    fillGhostCardPrStatus(document, (key) => statuses.get(key), t);
    expect(first.textContent).toContain('unresolved:2');
    expect(second.textContent).not.toContain('unresolved');
    expect(second.textContent).not.toBe('two');
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
    expect(slot.textContent).toBe('3passedthreadsNone');
  });
});
