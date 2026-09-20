import { describe, expect, it } from 'vitest';
import {
  projectSidebarSessionActivity,
  resolveSidebarRightStatus,
} from '../features/cc-agent/sidebar/sidebarRightStatus';
import { resolveCollapsedAttention } from '../features/cc-agent/sidebar/projectCollapsedAttention';

const interruption = {
  status: 'active',
  activeTurnStartedAt: 1000,
  interruptedTurnStartedAt: 1000,
  lastTurnEndedAt: 900,
};

describe('persisted interruption on remote Desktop', () => {
  it('keeps interrupted tasks without a red dot', () => {
    const input = {
      sessionId: 'remote',
      interruption,
      attentionKind: undefined,
      isUrgentFromContext: false,
      isRunning: false,
      hasAttentionNotification: false,
    };
    expect(resolveSidebarRightStatus(projectSidebarSessionActivity(input))).toBe('time');
    expect(
      resolveSidebarRightStatus(
        projectSidebarSessionActivity({
          ...input,
          interruption: { ...interruption, lastTurnEndedAt: 1000 },
        }),
      ),
    ).toBe('time');
  });

  it('exposes an older interrupted child in collapsed projects and automation groups', () => {
    const input = {
      sessions: [{ id: 'old', ...interruption }, { id: 'new' }],
      runningSessionIds: new Set<string>(),
      notifications: new Set<string>(),
      attentionKinds: new Map(),
      urgentSessionIds: new Set<string>(),
      remotePhaseOf: () => undefined,
    };
    expect(resolveCollapsedAttention(input)).toEqual({ tone: null, errorSessionIds: ['old'] });
    expect(
      resolveCollapsedAttention({
        ...input,
        sessions: [{ id: 'old', ...interruption, lastTurnEndedAt: 1000 }],
      }),
    ).toEqual({ tone: null, errorSessionIds: [] });
  });
});
