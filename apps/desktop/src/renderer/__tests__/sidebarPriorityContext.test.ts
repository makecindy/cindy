import { expect, it } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { sidebarPriorityContext } from '../features/cc-agent/lib/sidebarPriorityContext';
import {
  advanceViewedPriorityHold,
  holdViewedPriorityRank,
  sessionPriorityRank,
} from '../features/cc-agent/lib/mainListModel';
import { LIVE_TASK_PRIORITY } from '../../shared/liveTaskPriority';

it.each([
  ['completed', LIVE_TASK_PRIORITY.unread],
  ['needs-interaction', LIVE_TASK_PRIORITY.waiting],
  ['error', LIVE_TASK_PRIORITY.waiting],
  ['running', LIVE_TASK_PRIORITY.running],
] as const)('captures remote %s before the read receipt removes its activity', (phase, rank) => {
  const session = { id: 'remote', deviceLinkDeviceId: 'device' } as Session;
  const local = { runningSessionIds: new Set<string>(), attentionSessionIds: new Set<string>() };
  const state = {
    heldPriorityRanks: new Map<string, number>(),
    recentlyViewedAtMs: new Map<string, number>(),
  };
  const beforeRead = sidebarPriorityContext(local, [session], () => phase);
  expect(sessionPriorityRank(session, beforeRead)).toBe(rank);
  holdViewedPriorityRank(state, session.id, beforeRead);
  const afterRead = sidebarPriorityContext(local, [session], () => undefined);
  advanceViewedPriorityHold(state, session.id, afterRead, 1000);
  expect(sessionPriorityRank(session, { ...afterRead, ...state })).toBe(rank);
  advanceViewedPriorityHold(state, 'other', afterRead, 2000);
  expect(sessionPriorityRank(session, { ...afterRead, ...state })).toBe(LIVE_TASK_PRIORITY.rest);
});
