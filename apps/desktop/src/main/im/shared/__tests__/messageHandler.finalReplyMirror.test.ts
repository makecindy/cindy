import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  activateImAccountBoundary,
  deactivateImAccountBoundary,
} from '../../accountBoundary';
import { createMessageHandler } from '../messageHandler';
import type { IMMessageEvent } from '@cindy/im';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function inboundEvent(overrides: Partial<IMMessageEvent> = {}): IMMessageEvent {
  return {
    channelName: 'feishu',
    senderId: 'g/oc_group/omt_topic',
    chatId: 'oc_group',
    contextId: 'cli_bot',
    messageId: 'om_1',
    text: 'hello',
    attachments: [],
    unsupported: [],
    ...overrides,
  };
}

describe('messageHandler parent-chat mirror retain', () => {
  beforeEach(() => {
    activateImAccountBoundary();
  });

  afterEach(() => {
    activateImAccountBoundary();
  });

  it('releases a queued parent-chat mirror retain when the IM account generation drops', async () => {
    const gate = deferred();
    const release = vi.fn();
    const retainFinalReplyMirror = vi.fn(() => release);
    const runAgentTurn = vi.fn(async () => {
      await gate.promise;
    });

    const attach = createMessageHandler(
      {
        channel: 'feishu',
        processingEmoji: 'OK',
        output: { kind: 'rich-card', im: { retainFinalReplyMirror } },
        ui: {
          agent: {
            sendInternalError: () => 'internal',
            unsupportedOnly: () => 'unsupported',
            unsupportedNotice: () => 'notice',
          },
        },
      } as never,
      { handleSlashCommand: vi.fn() } as never,
      { runAgentTurn } as never,
    );

    let onMessage: ((event: IMMessageEvent) => void) | undefined;
    attach({
      name: 'feishu',
      onMessage: (handler: (event: IMMessageEvent) => void) => {
        onMessage = handler;
        return () => undefined;
      },
      sendText: vi.fn(async () => ({ messageId: 'om_text' })),
      sendMarkdownText: vi.fn(async () => ({ messageId: 'om_md' })),
    } as never);

    onMessage?.(inboundEvent());
    await vi.waitFor(() => expect(runAgentTurn).toHaveBeenCalledTimes(1));
    onMessage?.(
      inboundEvent({
        messageId: 'om_queued',
        finalReplyMirror: {
          kind: 'parent-chat',
          chatId: 'oc_group',
          idempotencyKey: 'k'.repeat(64),
          accountEpoch: 1,
        },
      }),
    );

    expect(retainFinalReplyMirror).toHaveBeenCalledTimes(1);
    expect(release).not.toHaveBeenCalled();

    deactivateImAccountBoundary();
    gate.resolve();
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(runAgentTurn).toHaveBeenCalledTimes(1);
  });

  it('releases a queued parent-chat mirror retain when message preprocessing throws', async () => {
    const release = vi.fn();
    const retainFinalReplyMirror = vi.fn(() => release);
    const runAgentTurn = vi.fn();

    const attach = createMessageHandler(
      {
        channel: 'feishu',
        processingEmoji: 'OK',
        output: { kind: 'rich-card', im: { retainFinalReplyMirror } },
        turnPermissionPolicyFor: () => {
          throw new Error('policy exploded');
        },
        ui: {
          agent: {
            sendInternalError: () => 'internal',
            unsupportedOnly: () => 'unsupported',
            unsupportedNotice: () => 'notice',
          },
        },
      } as never,
      { handleSlashCommand: vi.fn() } as never,
      { runAgentTurn } as never,
    );

    let onMessage: ((event: IMMessageEvent) => void) | undefined;
    attach({
      name: 'feishu',
      onMessage: (handler: (event: IMMessageEvent) => void) => {
        onMessage = handler;
        return () => undefined;
      },
      sendText: vi.fn(async () => ({ messageId: 'om_text' })),
      sendMarkdownText: vi.fn(async () => ({ messageId: 'om_md' })),
    } as never);

    onMessage?.(
      inboundEvent({
        finalReplyMirror: {
          kind: 'parent-chat',
          chatId: 'oc_group',
          idempotencyKey: 'unexpected-error',
          accountEpoch: 1,
        },
      }),
    );

    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(1));
    expect(retainFinalReplyMirror).toHaveBeenCalledTimes(1);
    expect(runAgentTurn).not.toHaveBeenCalled();
  });
});
