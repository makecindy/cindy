import { describe, expect, it } from 'vitest';
import { hasPendingSessionInterruption } from '../sessionActivity.js';
import { groupAutomationListItems, toRemoteSessionListItem } from '../sessionList.js';

describe('shared persisted interruption projection', () => {
  const interrupted = {
    status: 'active', activeTurnStartedAt: 1000, interruptedTurnStartedAt: 1000,
    lastTurnEndedAt: 900,
  };

  it('requires host evidence and keeps resolutions independent of the viewing device clock', () => {
    expect(hasPendingSessionInterruption(interrupted)).toBe(true);
    for (const patch of [
      { interruptedTurnStartedAt: undefined }, { interruptedTurnStartedAt: NaN },
      { activeTurnStartedAt: 2000 }, { lastTurnEndedAt: 1000 },
      { clearedAt: new Date(1000).toISOString() }, { status: 'archived' },
    ]) expect(hasPendingSessionInterruption({ ...interrupted, ...patch })).toBe(false);
  });

  it('makes an older interrupted automation the collapsed group target until handled', () => {
    const base = { agentKind: 'cc', createdAt: new Date(1000).toISOString(), updatedAt: new Date(1000).toISOString(), model: '', title: 'Patrol', workingDir: null, source: 'scheduler', status: 'active' };
    const old = { ...base, ...interrupted, id: 'old' };
    const latest = { ...base, id: 'latest', updatedAt: new Date(3000).toISOString() };
    const group = (prior: typeof old) => groupAutomationListItems([toRemoteSessionListItem(prior), toRemoteSessionListItem(latest)], 4000)[0];
    expect(group(old).automationGroup?.primarySessionId).toBe('old');
    expect(group({ ...old, lastTurnEndedAt: 1000 }).automationGroup?.primarySessionId).toBe('latest');
  });
});
