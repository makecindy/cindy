import { describe, expect, it } from 'vitest';

import type { ChatMessage } from '../makerChatStore';
import {
  aggregateAssistantTurnUsageDetails,
  collectAssistantTurnUsageDetails,
} from '../userTurnUsage';
import { buildTurnUsageDetails } from '../../../shared/turnUsageDetails';
import { usdMoney } from '../../../shared/regionalMoney';

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
