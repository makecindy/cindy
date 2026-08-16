import { describe, expect, it } from 'vitest';

import {
  BOT_SESSION_EVENT,
  matchesBotEventSubscription,
  normalizeBotEventSubscriptionRule,
  type BotSessionEventPayload,
} from '../botSessionEvents';

const EVENT: BotSessionEventPayload = {
  sessionId: 'task-1',
  eventType: BOT_SESSION_EVENT.STATE_TRANSITION,
  transitionId: 'transition-1',
  title: '发布流程 · 待总控',
  status: 'active',
  source: 'desktop',
  workingDir: '/repo/cindy',
  occurredAt: 10,
  previousState: {
    lifecycle: 'active',
    execution: 'running',
    attention: null,
    workflow: null,
  },
  currentState: {
    lifecycle: 'active',
    execution: 'normal-ended',
    attention: 'needs-user',
    workflow: { key: 'awaiting-controller', label: '待总控' },
  },
  changedFacets: ['execution', 'attention', 'workflow'],
  outcome: 'completed',
  workflowState: { key: 'awaiting-controller', label: '待总控' },
};

describe('Bot task-state transition subscriptions', () => {
  it('normalizes logical rules and upgrades the short-lived Draft rule shape', () => {
    expect(normalizeBotEventSubscriptionRule({
      sessionRelations: [' delegated-by-bot ', 'delegated-by-bot'],
      executionStates: [' normal-ended ', 'normal-ended'],
      activationMode: 'inbox-only',
      resultDelivery: 'none',
    })).toEqual({
      sessionRelations: ['delegated-by-bot'],
      executionStates: ['normal-ended'],
      excludeOwnBotSessions: true,
      activationMode: 'inbox-only',
      resultDelivery: 'none',
    });

    expect(normalizeBotEventSubscriptionRule({
      eventTypes: ['session.turn.completed', 'session.turn.failed'],
      decisionStates: ['待总控'],
      wakeMode: 'manual',
      resultDelivery: 'none',
    } as never)).toEqual({
      sessionRelations: ['all-local'],
      executionStates: ['normal-ended', 'error-ended'],
      workflowStates: ['待总控'],
      excludeOwnBotSessions: true,
      activationMode: 'inbox-only',
      resultDelivery: 'none',
    });
  });

  it('matches changed unified-state facets plus logical relation and metadata filters', () => {
    expect(matchesBotEventSubscription({
      sessionRelations: ['delegated-by-bot'],
      executionStates: ['normal-ended'],
      workflowStates: ['待总控'],
      sources: ['desktop'],
      workingDirPrefixes: ['/repo'],
      activationMode: 'heartbeat-turn',
      resultDelivery: 'all-active-routes',
    }, EVENT, 'control-bot', { sessionRelations: ['delegated-by-bot'] })).toBe(true);

    expect(matchesBotEventSubscription({
      sessionRelations: ['watched-by-bot'],
      executionStates: ['normal-ended'],
      activationMode: 'heartbeat-turn',
      resultDelivery: 'none',
    }, EVENT, 'control-bot', { sessionRelations: ['delegated-by-bot'] })).toBe(false);
  });

  it('does not treat a snapshot with the same facet value as a transition', () => {
    expect(matchesBotEventSubscription({
      sessionRelations: ['all-local'],
      executionStates: ['normal-ended'],
      activationMode: 'heartbeat-turn',
      resultDelivery: 'none',
    }, {
      ...EVENT,
      previousState: { ...EVENT.currentState! },
      changedFacets: [],
    }, 'control-bot')).toBe(false);
  });

  it('stops self-notifications, cross-Bot cycles and excessive hops', () => {
    const rule = {
      sessionRelations: ['all-local'],
      executionStates: ['normal-ended'],
      activationMode: 'heartbeat-turn' as const,
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
