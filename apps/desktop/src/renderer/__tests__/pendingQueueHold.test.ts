import { describe, expect, it } from 'vitest';

import {
  findStopIndex,
  queueRowActionWidth,
  resolveQueueHoldRow,
} from '@/components/new-chat/pendingQueueHold';
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

const rowOpts = { canSteer: true, canEdit: true };
const row = (queue: QueuedMessage[], index: number) =>
  resolveQueueHoldRow(queue[index]!, findStopIndex(queue), index, rowOpts);

describe('pending queue hold row projection', () => {
  it('offers hold only before the stop point and keeps four buttons', () => {
    const queue = [queuedMessage('a'), queuedMessage('b'), queuedMessage('c')];

    expect(findStopIndex(queue)).toBe(-1);
    expect(row(queue, 1)).toMatchObject({
      isHeld: false,
      isAfterStop: false,
      canHold: true,
      canRelease: false,
      canSteer: true,
      leading: 'drag',
      draggable: true,
      dimmed: false,
    });
    expect(queueRowActionWidth(4)).toBe('w-[92px]');
  });

  it('makes the held row a stop point with resume instead of hold or steer', () => {
    const queue = [queuedMessage('a'), queuedMessage('b', { held: true }), queuedMessage('c')];

    expect(findStopIndex(queue)).toBe(1);
    expect(row(queue, 1)).toMatchObject({
      isHeld: true,
      isAfterStop: false,
      canHold: false,
      canRelease: true,
      canSteer: false,
      leading: 'held',
      draggable: false,
      dimmed: true,
    });
    expect(queueRowActionWidth(3)).toBe('w-[68px]');
  });

  it('dims the rows behind the stop point without offering another hold', () => {
    const queue = [queuedMessage('a'), queuedMessage('b', { held: true }), queuedMessage('c')];

    expect(row(queue, 2)).toMatchObject({
      isHeld: false,
      isAfterStop: true,
      canHold: false,
      canRelease: false,
      canSteer: true,
      leading: 'drag',
      draggable: false,
      dimmed: true,
    });
    expect(queueRowActionWidth(3)).toBe('w-[68px]');
  });

  it('never steers the held row even when the sender is steerable', () => {
    const queue = [queuedMessage('a', { held: true })];

    expect(row(queue, 0)).toMatchObject({ isHeld: true, canSteer: false, canRelease: true });
    expect(resolveQueueHoldRow(queue[0]!, 0, 0, { canSteer: false, canEdit: false })).toMatchObject({
      canSteer: false,
      canRelease: true,
    });
  });
});
