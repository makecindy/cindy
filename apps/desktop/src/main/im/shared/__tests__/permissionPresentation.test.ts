import { describe, expect, it, vi } from 'vitest';
import type { InteractiveCardSpec } from '@cindy/im';
import { createSharedPermission } from '../../../maker-ipc/sharedPermission';
import { presentSharedPermissionCard } from '../permissionPresentation';
import {
  cancelPending,
  lookupPending,
  rejectAllPending,
  resolvePending,
} from '../pendingInteractions';
import { describeInteractionSource } from '../interactionSource';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function presentation(requestId: string, send = vi.fn(async () => ({ messageId: 'dm|7' }))) {
  const permission = createSharedPermission();
  const update = vi.fn<(messageId: string, spec: InteractiveCardSpec) => Promise<void>>(
    async () => {},
  );
  const onError = vi.fn();
  const result = presentSharedPermissionCard({
    requestId,
    toolName: 'Bash',
    owner: Symbol(),
    permission,
    send,
    update,
    onError,
    resolved: (decision) => ({
      title: 'Bash',
      body: `来源：群 A\n原消息：检查仓库\n${decision.kind === 'permission' && decision.behavior}`,
      buttons: [],
    }),
  });
  return { permission, update, result, onError };
}

describe('shared IM permission presentation', () => {
  it('retains source and the Desktop result when the card arrives after confirmation', async () => {
    const sent = deferred<{ messageId: string }>();
    const p = presentation(
      'late-send',
      vi.fn(() => sent.promise),
    );
    expect(lookupPending('late-send')).not.toBeNull();
    expect(p.permission.decide({ kind: 'permission', behavior: 'allow' })).toBe(true);
    await expect(p.result).resolves.toMatchObject({ behavior: 'allow' });
    expect(resolvePending('late-send', { kind: 'permission', behavior: 'deny' })).toBeNull();
    expect(p.update).not.toHaveBeenCalled();
    sent.resolve({ messageId: 'dm|8' });
    await vi.waitFor(() =>
      expect(p.update).toHaveBeenCalledWith('dm|8', {
        title: 'Bash',
        body: '来源：群 A\n原消息：检查仓库\nallow',
        buttons: [],
      }),
    );
  });

  it('accepts only the first IM/Desktop answer, including back-to-back synchronous clicks', async () => {
    const p = presentation('double-click');
    expect(resolvePending('double-click', { kind: 'permission', behavior: 'deny' })).toMatchObject({
      shared: true,
    });
    expect(p.permission.decide({ kind: 'permission', behavior: 'allow' })).toBe(false);
    await expect(p.result).resolves.toMatchObject({ behavior: 'deny' });
    await vi.waitFor(() => expect(p.update).toHaveBeenCalledOnce());
    expect(p.update.mock.calls[0][1].body).toContain('deny');
    expect(lookupPending('double-click')).toBeNull();
  });

  it('cancels both presentations and closes a late card without losing its source', async () => {
    const sent = deferred<{ messageId: string }>();
    const p = presentation(
      'cancel-send',
      vi.fn(() => sent.promise),
    );
    cancelPending('cancel-send', 'session_disposed');
    await expect(p.result).resolves.toMatchObject({ behavior: 'deny', reason: 'session_disposed' });
    sent.resolve({ messageId: 'dm|9' });
    await vi.waitFor(() => expect(p.update).toHaveBeenCalledOnce());
    expect(p.update.mock.calls[0][1].body).toContain('来源：群 A');
    expect(p.permission.decide({ kind: 'permission', behavior: 'allow' })).toBe(false);
  });

  it('keeps Cindy usable if the IM send fails, without retrying or rejecting execution', async () => {
    const p = presentation(
      'send-failed',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await vi.waitFor(() => expect(p.onError).toHaveBeenCalledOnce());
    expect(p.permission.decision).toBeUndefined();
    p.permission.decide({ kind: 'permission', behavior: 'allow' });
    await expect(p.result).resolves.toMatchObject({ behavior: 'allow' });
    expect(p.update).not.toHaveBeenCalled();
  });

  it('lets the shared presenter close the card when its runner is disposed', async () => {
    const p = presentation('disposed');
    expect(rejectAllPending('session_disposed')).toEqual([]);
    await expect(p.result).resolves.toMatchObject({ behavior: 'deny', reason: 'session_disposed' });
    await vi.waitFor(() => expect(p.update).toHaveBeenCalledOnce());
    expect(p.update.mock.calls[0][1].body).toContain('来源：群 A');
  });
});

describe('IM permission source', () => {
  it('uses the admitted message and provider metadata, bounded independently of later messages', () => {
    const text = describeInteractionSource({
      channelName: 'telegram',
      chatId: '-100200',
      text: '检查仓库'.repeat(100),
      interactionSource: {
        chatName: '开发群',
        threadName: '日常讨论',
        senderName: 'Dash',
        messageUrl: 'https://t.me/c/200/7',
      },
    });
    expect(text).toContain('开发群');
    expect(text).toContain('日常讨论');
    expect(text).toContain('Dash');
    expect(text).toContain('https://t.me/c/200/7');
    expect(text.length).toBeLessThan(350);
  });

  it('supports a future channel without metadata and never copies protected message text', () => {
    expect(
      describeInteractionSource({ channelName: 'future-im', chatId: 'group-1', text: 'hello' }),
    ).toContain('future-im · group-1');
    const text = describeInteractionSource({
      channelName: 'telegram',
      chatId: '1',
      text: 'secret source',
      protectedContent: true,
      interactionSource: { messageUrl: 'javascript:alert(1)' },
    });
    expect(text).not.toContain('secret source');
    expect(text).not.toContain('javascript:');
  });
});
