import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  coordinateDualDelivery,
  resetDualDeliveryForTest,
  scheduleMirrorOnConfirmation,
  waitForMirrorConfirmation,
} from '../dualDelivery.js';

function input(overrides: Partial<Parameters<typeof coordinateDualDelivery>[0]> = {}) {
  return {
    appId: 'cli_test',
    chatId: 'oc_group',
    senderOpenId: 'ou_owner',
    createTime: '1788000000000',
    messageType: 'text',
    rawContent: JSON.stringify({ text: '@_user_1 hello' }),
    messageId: 'om_thread',
    threadId: 'omt_topic',
    ...overrides,
  };
}

afterEach(() => {
  resetDualDeliveryForTest();
  vi.useRealTimers();
});

describe('Feishu native thread/main dual delivery', () => {
  it('prefers the topic event when the main-feed copy arrives first', async () => {
    const flat = coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    const topic = await coordinateDualDelivery(input());

    await expect(flat).resolves.toEqual({ kind: 'suppress-main-copy' });
    expect(topic).toEqual({ kind: 'dispatch', mirrorKey: expect.any(String) });
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(true);
  });

  it('suppresses a main-feed copy that arrives after topic dispatch', async () => {
    const topic = await coordinateDualDelivery(input());
    const flat = await coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));

    expect(topic.kind).toBe('dispatch');
    expect(flat).toEqual({ kind: 'suppress-main-copy' });
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(true);
  });

  it('dispatches an unpaired flat group message after the bounded wait', async () => {
    vi.useFakeTimers();
    const flat = coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    const flatDecision = await flat;
    expect(flatDecision).toMatchObject({ kind: 'dispatch', mirrorKey: expect.any(String) });
    if (flatDecision.kind !== 'dispatch' || !flatDecision.mirrorKey) {
      throw new Error('unpaired flat must expose mirrorKey');
    }
    await expect(waitForMirrorConfirmation(flatDecision.mirrorKey)).resolves.toBe(false);
  });

  it('does not merge equal text from different create_time values', async () => {
    vi.useFakeTimers();
    const flat = coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    const topic = await coordinateDualDelivery(
      input({ messageId: 'om_topic_later', createTime: '1788000000001' }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(flat).resolves.toMatchObject({ kind: 'dispatch' });
    expect(topic.kind).toBe('dispatch');
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(false);
  });

  it('does not correlate messages when Feishu omits create_time', async () => {
    const flat = await coordinateDualDelivery(
      input({ messageId: 'om_flat', threadId: '', createTime: '' }),
    );
    const topic = await coordinateDualDelivery(input({ createTime: '' }));

    expect(flat).toEqual({ kind: 'dispatch' });
    expect(topic).toEqual({ kind: 'dispatch' });
  });

  it('peeking taken-over does not commit an unpaired flat', async () => {
    vi.useFakeTimers();
    const flat = coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    const flatDecision = await flat;
    expect(flatDecision).toMatchObject({ kind: 'dispatch' });
    if (flatDecision.kind !== 'dispatch' || !flatDecision.isUnpairedFlatTakenOver) {
      throw new Error('unpaired flat must expose isUnpairedFlatTakenOver');
    }
    expect(flatDecision.isUnpairedFlatTakenOver()).toBe(false);

    const topic = await coordinateDualDelivery(input());
    expect(topic.kind).toBe('dispatch');
    expect(flatDecision.isUnpairedFlatTakenOver()).toBe(true);
    expect(flatDecision.commitUnpairedFlat?.()).toBe(false);
  });

  it('lets a late topic take over an unpaired flat that has not committed yet', async () => {
    vi.useFakeTimers();
    const flat = coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    const flatDecision = await flat;
    expect(flatDecision).toMatchObject({ kind: 'dispatch' });
    if (flatDecision.kind !== 'dispatch' || !flatDecision.commitUnpairedFlat) {
      throw new Error('unpaired flat must expose commitUnpairedFlat');
    }

    const topic = await coordinateDualDelivery(input());
    expect(topic).toEqual({ kind: 'dispatch', mirrorKey: expect.any(String) });
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(true);
    expect(flatDecision.commitUnpairedFlat()).toBe(false);
  });

  it('suppresses a late topic after the unpaired flat has committed its route', async () => {
    vi.useFakeTimers();
    const flat = coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    const flatDecision = await flat;
    expect(flatDecision).toMatchObject({ kind: 'dispatch', mirrorKey: expect.any(String) });
    if (
      flatDecision.kind !== 'dispatch' ||
      !flatDecision.mirrorKey ||
      !flatDecision.commitUnpairedFlat
    ) {
      throw new Error('unpaired flat must expose mirrorKey and commitUnpairedFlat');
    }
    expect(flatDecision.commitUnpairedFlat()).toBe(true);

    const scheduled = vi.fn();
    scheduleMirrorOnConfirmation(flatDecision.mirrorKey, scheduled);
    expect(scheduled).not.toHaveBeenCalled();

    await expect(coordinateDualDelivery(input())).resolves.toEqual({
      kind: 'suppress-main-copy',
    });
    expect(scheduled).toHaveBeenCalledTimes(1);
    await expect(waitForMirrorConfirmation(flatDecision.mirrorKey)).resolves.toBe(true);
  });

  it('suppresses a later main-feed copy after a late topic has taken over', async () => {
    vi.useFakeTimers();
    const firstFlat = coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    await firstFlat;
    const topic = await coordinateDualDelivery(input());
    expect(topic.kind).toBe('dispatch');

    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat_retry', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
  });

  it('delivers a scheduled mirror when the main-feed copy arrives after the pair window', async () => {
    vi.useFakeTimers();
    const topic = await coordinateDualDelivery(input());
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(false);

    const scheduled = vi.fn();
    scheduleMirrorOnConfirmation(topic.mirrorKey, scheduled);
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it('writes a recent-thread tombstone when a pending pair is capacity-evicted', async () => {
    // Must stay in lockstep with dualDelivery MAX_PENDING (512).
    const pendingCap = 512;
    const first = await coordinateDualDelivery(
      input({ createTime: '1', messageId: 'om_t0', threadId: 'omt_0' }),
    );
    expect(first).toEqual({ kind: 'dispatch', mirrorKey: expect.any(String) });

    for (let i = 1; i <= pendingCap; i++) {
      await coordinateDualDelivery(
        input({
          createTime: String(i + 1),
          messageId: `om_t${i}`,
          threadId: `omt_${i}`,
        }),
      );
    }

    vi.useFakeTimers();
    const lateFlat = coordinateDualDelivery(
      input({ createTime: '1', messageId: 'om_flat', threadId: '' }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(lateFlat).resolves.toEqual({ kind: 'suppress-main-copy' });
  });

  it('writes a recent-flat tombstone when a pending pair is capacity-evicted', async () => {
    const pendingCap = 512;
    const firstFlat = coordinateDualDelivery(
      input({ createTime: '1', messageId: 'om_f0', threadId: '' }),
    );
    for (let i = 1; i <= pendingCap; i++) {
      void coordinateDualDelivery(
        input({
          createTime: String(i + 1),
          messageId: `om_f${i}`,
          threadId: '',
        }),
      );
    }
    const firstDecision = await firstFlat;
    expect(firstDecision).toMatchObject({ kind: 'dispatch' });
    if (firstDecision.kind !== 'dispatch' || !firstDecision.commitUnpairedFlat) {
      throw new Error('evicted unpaired flat must expose commitUnpairedFlat');
    }

    const lateTopic = await coordinateDualDelivery(
      input({ createTime: '1', messageId: 'om_t0', threadId: 'omt_0' }),
    );
    expect(lateTopic).toEqual({ kind: 'dispatch', mirrorKey: expect.any(String) });
    expect(firstDecision.commitUnpairedFlat()).toBe(false);
  });

  it('does not suppress a copy after the late-copy window, and drops the deferred mirror', async () => {
    vi.useFakeTimers();
    const topic = await coordinateDualDelivery(input());
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    await vi.advanceTimersByTimeAsync(1_000);
    const scheduled = vi.fn();
    scheduleMirrorOnConfirmation(topic.mirrorKey, scheduled);
    await vi.advanceTimersByTimeAsync(25_001);

    const lateFlat = coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(lateFlat).resolves.toMatchObject({ kind: 'dispatch' });
    expect(scheduled).not.toHaveBeenCalled();
  });
});
