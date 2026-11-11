import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../makerChatStore';
import {
  aggregateAssistantTurnUsageDetails,
  collectAssistantTurnUsageDetails,
  collectAssistantTurnElapsedMs,
} from '../userTurnUsage';
import { buildTurnUsageDetails } from '../../../shared/turnUsageDetails';
import { usdMoney } from '../../../shared/regionalMoney';

// #9806, unit: selected reply elapsed time must span work-group splits and waits.
// Existing usage tests only covered tokens. Minimal failure: a user at 22:05:20
// and a reply at 23:05:50 must produce 3,630,000ms, not the last 457,000ms segment.
describe('collectAssistantTurnElapsedMs', () => {
  const at = (message: ChatMessage, seconds: number): ChatMessage => ({
    ...message, createdAt: new Date(Date.UTC(2026, 10, 10, 22, 5, 20) + seconds * 1000).toISOString(),
  });

  it('includes intermediate deliveries, long waits, steer and recovery without restarting the clock', () => {
    const messages = [
      at(user('u1'), 0),
      at(assistant('delivery', undefined), 600),
      at({ ...user('steer'), delivery: 'steer' }, 1200),
      at(user('resume', 'auto-resume'), 3000),
      at(assistant('segment', undefined), 3173),
      at(assistant('final', undefined), 3630),
      at(user('u2'), 4000),
      at(assistant('next', undefined), 4005),
    ];
    expect([...collectAssistantTurnElapsedMs(messages, new Set(['final', 'next']))])
      .toEqual([['final', 3_630_000], ['next', 5000]]);
  });

  it.each([undefined, '', 'invalid', '2026-11-11T00:00:00Z'])('omits a turn with missing, invalid or reversed start time (%s)', (createdAt) => {
    const messages = [{ ...user('u'), createdAt }, at(assistant('a', undefined), 1)];
    expect(collectAssistantTurnElapsedMs(messages, new Set(['a'])).size).toBe(0);
  });

  it('does not borrow a boundary from an older turn or an unloaded start', () => {
    const messages = [
      at(assistant('unloaded', undefined), 1),
      at(user('u'), 2),
      user('missing-time'),
      at(assistant('a', undefined), 3),
    ];
    expect(collectAssistantTurnElapsedMs(messages, new Set(['unloaded', 'a'])).size).toBe(0);
  });

  it('omits unfinished and invalid replies but preserves a same-millisecond duration', () => {
    const messages = [
      at(user('u'), 0),
      at({ ...assistant('streaming', undefined), isStreaming: true }, 1),
      at({ ...assistant('failed', undefined), turnCompleted: false }, 2),
      assistant('missing', undefined),
      { ...assistant('invalid', undefined), createdAt: 'invalid' },
      at(assistant('instant', undefined), 0),
    ];
    expect([...collectAssistantTurnElapsedMs(messages, new Set(messages.map((m) => m.clientId)))])
      .toEqual([['instant', 0]]);
  });
});

function assistant(
  clientId: string,
  turnUsageDetails: ChatMessage['turnUsageDetails'],
): ChatMessage {
  return {
    clientId,
    role: 'assistant',
    content: clientId,
    turnUsageDetails,
  };
}

function user(clientId: string, systemCardType?: ChatMessage['systemCardType']): ChatMessage {
  return {
    clientId,
    role: 'user',
    content: clientId,
    delivery: 'turn',
    ...(systemCardType ? { systemCardType } : {}),
  };
}

describe('aggregateAssistantTurnUsageDetails', () => {
  it('merges every SDK segment after the latest real user boundary', () => {
    const first = buildTurnUsageDetails({
      inputTokens: 10,
      outputTokens: 20,
      cacheReadTokens: 100,
      cacheCreateTokens: 5,
      perModelCost: [{ model: 'claude-fable-5', money: usdMoney(2) }],
    });
    const final = buildTurnUsageDetails({
      inputTokens: 3,
      outputTokens: 7,
      cacheReadTokens: 50,
      cacheCreateTokens: 2,
      perModelCost: [{ model: 'claude-opus-5', money: usdMoney(4) }],
    });
    const details = aggregateAssistantTurnUsageDetails(
      [
        user('u1'),
        assistant('a1', first ?? undefined),
        user('resume', 'auto-resume'),
        assistant('a2', final ?? undefined),
      ],
      'a2',
    );

    expect(details?.totalTokens).toBe(197);
    expect(details?.perModelCost).toEqual([
      { model: 'claude-fable-5', money: usdMoney(2) },
      { model: 'claude-opus-5', money: usdMoney(4) },
    ]);
  });

  it('does not merge into an older turn when the loaded history has no boundary', () => {
    const old = buildTurnUsageDetails({ inputTokens: 1, outputTokens: 1 });
    const current = buildTurnUsageDetails({ inputTokens: 2, outputTokens: 2 });
    const details = aggregateAssistantTurnUsageDetails(
      [assistant('old', old ?? undefined), assistant('current', current ?? undefined)],
      'current',
    );
    expect(details).toBe(current);
  });

  it('collects selected final assistants in one pass without crossing user turns', () => {
    const first = buildTurnUsageDetails({ inputTokens: 10, outputTokens: 5 })!;
    const resumed = buildTurnUsageDetails({ inputTokens: 4, outputTokens: 1 })!;
    const next = buildTurnUsageDetails({ inputTokens: 3, outputTokens: 2 })!;
    const messages = [
      user('u1'),
      assistant('a1', first),
      user('resume', 'auto-resume'),
      assistant('a2', resumed),
      user('u2'),
      assistant('a3', next),
    ];

    const details = collectAssistantTurnUsageDetails(messages, new Set(['a2', 'a3']));
    expect(details.get('a2')?.totalTokens).toBe(20);
    expect(details.get('a3')).toBe(next);
    expect(details.has('a1')).toBe(false);
  });
});
