import { describe, expect, it } from 'vitest';

import {
  BOT_SESSION_EVENT,
  matchesBotEventSubscription,
  normalizeBotEventSubscriptionRule,
  type BotSessionEventPayload,
} from '../botSessionEvents';

const EVENT: BotSessionEventPayload = {
  sessionId: 'task-1',
  eventType: BOT_SESSION_EVENT.DECISION_REQUIRED,
  title: '发布流程 · 待总控',
  status: 'active',
  source: 'desktop',
  workingDir: '/repo/cindy',
  occurredAt: 10,
  decisionState: '待总控',
};

describe('Bot task-event subscription rules', () => {
  it('normalizes open logical rules without closing the event namespace', () => {
    expect(normalizeBotEventSubscriptionRule({
      eventTypes: [' session.* ', 'session.*', 'custom.review.ready'],
      sources: ['desktop', 'desktop'],
      wakeMode: 'manual',
      resultDelivery: 'none',
    })).toEqual({
      eventTypes: ['session.*', 'custom.review.ready'],
      sources: ['desktop'],
      excludeOwnBotSessions: true,
      wakeMode: 'manual',
      resultDelivery: 'none',
    });
  });

  it('matches event prefixes, source, workdir and decision-state filters', () => {
    expect(matchesBotEventSubscription({
      eventTypes: ['session.*'],
      sources: ['desktop'],
      workingDirPrefixes: ['/repo'],
      decisionStates: ['待总控'],
      wakeMode: 'automatic',
      resultDelivery: 'all-active-routes',
    }, EVENT, 'control-bot')).toBe(true);

    expect(matchesBotEventSubscription({
      eventTypes: ['session.*'],
      sources: ['scheduler'],
      wakeMode: 'automatic',
      resultDelivery: 'none',
    }, EVENT, 'control-bot')).toBe(false);
  });

  it('stops self-notifications, cross-Bot cycles and excessive hops', () => {
    const rule = {
      eventTypes: ['*'],
      wakeMode: 'automatic' as const,
      resultDelivery: 'none' as const,
    };
    expect(matchesBotEventSubscription(rule, {
      ...EVENT,
      originBotId: 'control-bot',
    }, 'control-bot')).toBe(false);
    expect(matchesBotEventSubscription(rule, {
      ...EVENT,
      originBotId: 'worker-bot',
      lineage: ['worker-bot', 'control-bot'],
      hopCount: 2,
    }, 'control-bot')).toBe(false);
    expect(matchesBotEventSubscription(rule, {
      ...EVENT,
      originBotId: 'worker-bot',
      lineage: ['worker-bot'],
      hopCount: 8,
    }, 'control-bot')).toBe(false);
  });
});
