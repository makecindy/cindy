import { describe, expect, it } from 'vitest';

import { findStopIndex, resolveQueueHoldRow } from '@/components/new-chat/pendingQueueHold';
import type { QueuedMessage } from '@/lib/makerChatStore';

function queuedMessage(clientId: string, patch: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    clientId,
    text: clientId,
    persistedContent: clientId,
    model: 'claude-opus-4-7',
    effort: 'medium',
    permissionMode: 'default',
    workingDir: '/tmp/project',
    chatMessage: { clientId, role: 'user', content: clientId },
    createOpts: {
      agentKind: 'claude-code',
      workingDir: '/tmp/project',
      model: 'claude-opus-4-7',
      effort: 'medium',
      permissionMode: 'default',
    },
    ...patch,
  } as QueuedMessage;
}

describe('pending queue hold row projection', () => {
  it('offers hold to every row while no stop point exists', () => {
    const queue = [queuedMessage('a'), queuedMessage('b'), queuedMessage('c')];

    expect(findStopIndex(queue)).toBe(-1);
    expect(resolveQueueHoldRow(-1, 1)).toMatchObject({
      isHeld: false,
      isAfterStop: false,
      canHold: true,
      canRelease: false,
      canSteer: true,
      movable: true,
      dimmed: false,
    });
  });

  it('turns the held row into the stop point with resume instead of hold or steer', () => {
    const queue = [queuedMessage('a'), queuedMessage('b', { held: true }), queuedMessage('c')];

    expect(findStopIndex(queue)).toBe(1);
    expect(resolveQueueHoldRow(1, 1)).toMatchObject({
      isHeld: true,
      isAfterStop: false,
      canHold: false,
      canRelease: true,
      canSteer: false,
      movable: false,
      dimmed: true,
    });
  });

  it('dims the rows behind the stop point without offering another hold', () => {
    const queue = [queuedMessage('a'), queuedMessage('b', { held: true }), queuedMessage('c')];

    expect(resolveQueueHoldRow(findStopIndex(queue), 2)).toMatchObject({
      isHeld: false,
      isAfterStop: true,
      canHold: false,
      canRelease: false,
      canSteer: true,
      movable: false,
      dimmed: true,
    });
  });

  it('keeps the caller decision for steerability on the held row', () => {
    expect(resolveQueueHoldRow(0, 0, { canSteer: false })).toMatchObject({
      canSteer: false,
      canRelease: true,
    });
  });
});
