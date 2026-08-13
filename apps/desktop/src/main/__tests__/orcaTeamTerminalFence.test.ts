import { describe, expect, it } from 'vitest';

import { OrcaTeamTerminalFence } from '../orcaTeamTerminalFence.js';

describe('OrcaTeamTerminalFence', () => {
  it('fences a team synchronously while its terminal DB transition is pending', () => {
    const fence = new OrcaTeamTerminalFence();
    const transition = fence.begin('team-pending');

    expect(fence.has('team-pending')).toBe(true);
    expect(fence.getState('team-pending')).toBe('pending');
    fence.rollback(transition);
    expect(fence.has('team-pending')).toBe(false);
    expect(fence.getState('team-pending')).toBe('open');
  });

  it('releases pending-transition waiters with the durable outcome', async () => {
    const rollbackFence = new OrcaTeamTerminalFence();
    const rollback = rollbackFence.begin('team-rollback');
    const rollbackWait = rollbackFence.waitForPendingTransition('team-rollback');
    rollbackFence.rollback(rollback);
    await expect(rollbackWait).resolves.toBe('open');

    const commitFence = new OrcaTeamTerminalFence();
    const commit = commitFence.begin('team-commit');
    const commitWait = commitFence.waitForPendingTransition('team-commit');
    commitFence.commit(commit);
    await expect(commitWait).resolves.toBe('terminal');
  });

  it('keeps a committed terminal fence when another concurrent transition rolls back', () => {
    const fence = new OrcaTeamTerminalFence();
    const failedTransition = fence.begin('team-shared');
    const committedTransition = fence.begin('team-shared');

    fence.commit(committedTransition);
    fence.rollback(failedTransition);

    expect(fence.has('team-shared')).toBe(true);
    expect(fence.getState('team-shared')).toBe('terminal');
  });

  it('bounds committed history without evicting a pending transition', () => {
    const fence = new OrcaTeamTerminalFence(2);
    const pending = fence.begin('team-pending');

    fence.markTerminal('team-old');
    fence.markTerminal('team-new');

    expect(fence.has('team-pending')).toBe(true);
    expect(fence.has('team-old')).toBe(false);
    expect(fence.has('team-new')).toBe(true);

    fence.rollback(pending);
    expect(fence.has('team-pending')).toBe(false);
  });

  it('does not treat an active dispatch reservation as terminal', () => {
    const fence = new OrcaTeamTerminalFence();
    const reservation = fence.reserveDispatch('team-active');

    expect(fence.has('team-active')).toBe(false);
    fence.releaseDispatch(reservation);
    expect(fence.has('team-active')).toBe(false);
  });

  it('retains committed history while a pre-vendor dispatch reservation is active', () => {
    const fence = new OrcaTeamTerminalFence(2);
    const reservation = fence.reserveDispatch('team-reserved');
    fence.markTerminal('team-reserved');
    fence.markTerminal('team-old');
    fence.markTerminal('team-new');

    expect(fence.has('team-reserved')).toBe(true);
    expect(fence.has('team-old')).toBe(false);
    expect(fence.has('team-new')).toBe(true);

    fence.releaseDispatch(reservation);
    fence.markTerminal('team-newest');
    expect(fence.has('team-reserved')).toBe(false);
    expect(fence.has('team-newest')).toBe(true);
  });
});
