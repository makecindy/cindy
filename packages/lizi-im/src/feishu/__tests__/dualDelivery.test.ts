import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  coordinateDualDelivery,
  isMirrorConfirmationRetainedForTest,
  releaseMirrorConfirmation,
  resetDualDeliveryForTest,
  retainMirrorConfirmation,
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
    expect(topic).toMatchObject({
      kind: 'dispatch',
      mirrorKey: expect.any(String),
      alreadyConfirmed: true,
    });
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

  it('retains a live turn confirmation past the normal TTL and cache cap', async () => {
    vi.useFakeTimers();
    const topic = await coordinateDualDelivery(input());
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    retainMirrorConfirmation(topic.mirrorKey);
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });

    // Fill beyond MAX_CONFIRMED while consuming each unrelated mirror. The
    // target represents a still-running Agent turn and must remain pinned.
    for (let i = 0; i < 2_001; i++) {
      const fillerTopic = await coordinateDualDelivery(
        input({ createTime: `filler-${i}`, messageId: `om_filler_topic_${i}` }),
      );
      if (fillerTopic.kind !== 'dispatch' || !fillerTopic.mirrorKey) {
        throw new Error('missing filler mirror key');
      }
      await coordinateDualDelivery(
        input({
          createTime: `filler-${i}`,
          messageId: `om_filler_flat_${i}`,
          threadId: '',
        }),
      );
      await expect(waitForMirrorConfirmation(fillerTopic.mirrorKey)).resolves.toBe(true);
    }

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 1);
    await coordinateDualDelivery(
      input({ createTime: 'prune-trigger', messageId: 'om_prune_trigger' }),
    );

    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(true);
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat_after_terminal', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
  });

  it('does not pin a confirmed route until the caller emits an Agent turn', async () => {
    vi.useFakeTimers();
    const topic = await coordinateDualDelivery(input());
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 1);
    await coordinateDualDelivery(
      input({ createTime: 'prune-unemitted', messageId: 'om_prune_unemitted' }),
    );

    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(false);
  });

  it('releases an uncommitted topic lease so a later retry can acquire a fresh one', async () => {
    const topic = await coordinateDualDelivery(input());
    if (topic.kind !== 'dispatch' || !topic.commitTopic || !topic.abandonTopic) {
      throw new Error('elected topic must expose abandonTopic');
    }
    topic.abandonTopic();
    expect(topic.commitTopic()).toBe(false);

    const retry = await coordinateDualDelivery(
      input({ messageId: 'om_topic_retry', threadId: 'omt_topic' }),
    );
    expect(retry).toMatchObject({
      kind: 'dispatch',
      commitTopic: expect.any(Function),
      abandonTopic: expect.any(Function),
    });
    if (retry.kind !== 'dispatch' || !retry.commitTopic) {
      throw new Error('abandoned topic must allow a fresh lease');
    }
    expect(retry.commitTopic()).toBe(true);
  });

  it('allows an elected topic retry before the topic route commits', async () => {
    const topic = await coordinateDualDelivery(input());
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
    expect(topic).toMatchObject({
      kind: 'dispatch',
      mirrorKey: expect.any(String),
      commitTopic: expect.any(Function),
    });

    const retry = await coordinateDualDelivery(
      input({ messageId: 'om_topic_retry', threadId: 'omt_topic' }),
    );
    expect(retry).toMatchObject({
      kind: 'dispatch',
      mirrorKey: expect.any(String),
      alreadyConfirmed: true,
      commitTopic: expect.any(Function),
    });
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat_retry', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
  });

  it('suppresses a later topic retry after the elected topic route commits', async () => {
    const topic = await coordinateDualDelivery(input());
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
    if (topic.kind !== 'dispatch' || !topic.commitTopic) {
      throw new Error('elected topic must expose commitTopic');
    }
    expect(topic.commitTopic()).toBe(true);

    await expect(
      coordinateDualDelivery(input({ messageId: 'om_topic_retry' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
  });

  it('keeps a committed topic lease until the main-feed copy confirms the pair', async () => {
    const topic = await coordinateDualDelivery(input());
    if (topic.kind !== 'dispatch' || !topic.commitTopic) {
      throw new Error('elected topic must expose commitTopic');
    }
    expect(topic.commitTopic()).toBe(true);

    await expect(
      coordinateDualDelivery(input({ messageId: 'om_topic_retry', threadId: 'omt_topic' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
  });

  it('suppresses fresh flat message ids after the logical send is confirmed', async () => {
    vi.useFakeTimers();
    const topic = await coordinateDualDelivery(input());
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat_first', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });

    const duplicate = coordinateDualDelivery(
      input({ messageId: 'om_flat_second', threadId: '' }),
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(duplicate).resolves.toEqual({ kind: 'suppress-main-copy' });
    expect(topic).toMatchObject({ kind: 'dispatch', mirrorKey: expect.any(String) });
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

  it('elects only one route when duplicate flat ids share a logical send', async () => {
    vi.useFakeTimers();
    const firstFlat = coordinateDualDelivery(input({ messageId: 'om_flat_first', threadId: '' }));
    const secondFlat = coordinateDualDelivery(
      input({ messageId: 'om_flat_second', threadId: '' }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const firstDecision = await firstFlat;

    expect(firstDecision).toMatchObject({ kind: 'dispatch' });
    await expect(secondFlat).resolves.toEqual({ kind: 'suppress-main-copy' });
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat_third', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
    if (firstDecision.kind !== 'dispatch' || !firstDecision.commitUnpairedFlat) {
      throw new Error('elected flat must expose commitUnpairedFlat');
    }

    await expect(coordinateDualDelivery(input())).resolves.toMatchObject({
      kind: 'dispatch',
      mirrorKey: expect.any(String),
      alreadyConfirmed: true,
    });
    expect(firstDecision.commitUnpairedFlat()).toBe(false);
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
    expect(topic).toMatchObject({
      kind: 'dispatch',
      mirrorKey: expect.any(String),
      alreadyConfirmed: true,
    });
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(true);
    expect(flatDecision.commitUnpairedFlat()).toBe(false);
  });

  it('keeps an uncommitted flat route leased past the late-copy cache TTL', async () => {
    vi.useFakeTimers();
    const flat = coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    const flatDecision = await flat;
    if (flatDecision.kind !== 'dispatch' || !flatDecision.commitUnpairedFlat) {
      throw new Error('unpaired flat must expose commitUnpairedFlat');
    }

    await vi.advanceTimersByTimeAsync(25_001);
    await coordinateDualDelivery(
      input({ createTime: 'unrelated', messageId: 'om_unrelated', threadId: 'omt_other' }),
    );
    const lateTopic = await coordinateDualDelivery(input());

    expect(lateTopic).toMatchObject({
      kind: 'dispatch',
      mirrorKey: expect.any(String),
      alreadyConfirmed: true,
    });
    expect(flatDecision.commitUnpairedFlat()).toBe(false);
  });

  it('does not capacity-evict an uncommitted flat route lease', async () => {
    const firstFlat = coordinateDualDelivery(
      input({ createTime: 'capacity-0', messageId: 'om_capacity_0', threadId: '' }),
    );
    // MAX_PENDING (512) must be exceeded before records enter recentFlats, then
    // MAX_RECENT (1,000) must also be exceeded to exercise cache pruning.
    for (let i = 1; i <= 1_512; i++) {
      void coordinateDualDelivery(
        input({
          createTime: `capacity-${i}`,
          messageId: `om_capacity_${i}`,
          threadId: '',
        }),
      );
    }
    const flatDecision = await firstFlat;
    if (flatDecision.kind !== 'dispatch' || !flatDecision.commitUnpairedFlat) {
      throw new Error('capacity-evicted flat must expose commitUnpairedFlat');
    }

    const lateTopic = await coordinateDualDelivery(
      input({ createTime: 'capacity-0', messageId: 'om_capacity_topic' }),
    );

    expect(lateTopic).toMatchObject({
      kind: 'dispatch',
      mirrorKey: expect.any(String),
      alreadyConfirmed: true,
    });
    expect(flatDecision.commitUnpairedFlat()).toBe(false);
  });

  it('keeps an abandoned flat observable so a late topic confirms its mirror', async () => {
    vi.useFakeTimers();
    const flat = coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    const flatDecision = await flat;
    if (
      flatDecision.kind !== 'dispatch' ||
      !flatDecision.commitUnpairedFlat ||
      !flatDecision.abandonUnpairedFlat
    ) {
      throw new Error('unpaired flat must expose route lifecycle callbacks');
    }

    flatDecision.abandonUnpairedFlat();
    expect(flatDecision.commitUnpairedFlat()).toBe(false);
    const topic = await coordinateDualDelivery(input());
    expect(topic).toMatchObject({
      kind: 'dispatch',
      mirrorKey: expect.any(String),
      alreadyConfirmed: true,
    });
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(true);

    const scheduled = vi.fn();
    scheduleMirrorOnConfirmation(topic.mirrorKey, scheduled);
    expect(scheduled).toHaveBeenCalledTimes(1);
  });

  it('lets a fresh flat retry acquire a new route lease after abandonment', async () => {
    vi.useFakeTimers();
    const firstFlat = coordinateDualDelivery(input({ messageId: 'om_flat_first', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    const firstDecision = await firstFlat;
    if (firstDecision.kind !== 'dispatch' || !firstDecision.abandonUnpairedFlat) {
      throw new Error('unpaired flat must expose abandonUnpairedFlat');
    }
    firstDecision.abandonUnpairedFlat();

    const retry = coordinateDualDelivery(input({ messageId: 'om_flat_retry', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    const retryDecision = await retry;
    expect(retryDecision).toMatchObject({
      kind: 'dispatch',
      mirrorKey: expect.any(String),
      commitUnpairedFlat: expect.any(Function),
    });
    if (retryDecision.kind !== 'dispatch' || !retryDecision.commitUnpairedFlat) {
      throw new Error('retried flat must expose a fresh route lease');
    }
    expect(retryDecision.commitUnpairedFlat()).toBe(true);
  });

  it('releases inflight retain when an abandoned flat drops its deferred mirror', async () => {
    vi.useFakeTimers();
    const flat = coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    const flatDecision = await flat;
    if (
      flatDecision.kind !== 'dispatch' ||
      !flatDecision.mirrorKey ||
      !flatDecision.abandonUnpairedFlat
    ) {
      throw new Error('unpaired flat must expose abandonUnpairedFlat');
    }
    retainMirrorConfirmation(flatDecision.mirrorKey);
    const scheduled = vi.fn();
    expect(scheduleMirrorOnConfirmation(flatDecision.mirrorKey, scheduled)).toBe(true);
    flatDecision.abandonUnpairedFlat();
    expect(scheduled).not.toHaveBeenCalled();
    expect(isMirrorConfirmationRetainedForTest(flatDecision.mirrorKey)).toBe(false);
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
    expect(first).toMatchObject({ kind: 'dispatch', mirrorKey: expect.any(String) });

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
    expect(lateTopic).toMatchObject({
      kind: 'dispatch',
      mirrorKey: expect.any(String),
      alreadyConfirmed: true,
    });
    expect(firstDecision.commitUnpairedFlat()).toBe(false);
  });

  it('forgets unheld confirmations after the confirmed TTL', async () => {
    vi.useFakeTimers();
    const topic = await coordinateDualDelivery(input());
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 1);
    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(false);
    const lateFlat = coordinateDualDelivery(input({ messageId: 'om_flat_late', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(lateFlat).resolves.toMatchObject({ kind: 'dispatch' });
  });

  it('keeps a held confirmation past the confirmed TTL', async () => {
    vi.useFakeTimers();
    const topic = await coordinateDualDelivery(input());
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    retainMirrorConfirmation(topic.mirrorKey);

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 1);
    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(true);
    await expect(
      coordinateDualDelivery(input({ messageId: 'om_flat_late', threadId: '' })),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
    releaseMirrorConfirmation(topic.mirrorKey);
  });

  it('does not capacity-evict a held confirmation', async () => {
    const topic = await coordinateDualDelivery(input({ createTime: 'held-0', messageId: 'om_held' }));
    await expect(
      coordinateDualDelivery(
        input({ createTime: 'held-0', messageId: 'om_held_flat', threadId: '' }),
      ),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    retainMirrorConfirmation(topic.mirrorKey);

    for (let i = 1; i <= 2_001; i++) {
      await coordinateDualDelivery(
        input({ createTime: `held-${i}`, messageId: `om_held_t${i}` }),
      );
      await coordinateDualDelivery(
        input({ createTime: `held-${i}`, messageId: `om_held_f${i}`, threadId: '' }),
      );
    }

    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(true);
    await expect(
      coordinateDualDelivery(
        input({ createTime: 'held-0', messageId: 'om_held_later', threadId: '' }),
      ),
    ).resolves.toEqual({ kind: 'suppress-main-copy' });
    releaseMirrorConfirmation(topic.mirrorKey);
  });

  it('does not suppress a copy after the late-copy window, and drops the deferred mirror', async () => {
    vi.useFakeTimers();
    const topic = await coordinateDualDelivery(input());
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    retainMirrorConfirmation(topic.mirrorKey);
    await vi.advanceTimersByTimeAsync(1_000);
    const scheduled = vi.fn();
    scheduleMirrorOnConfirmation(topic.mirrorKey, scheduled);
    expect(isMirrorConfirmationRetainedForTest(topic.mirrorKey)).toBe(true);
    await vi.advanceTimersByTimeAsync(25_001);

    const lateFlat = coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(lateFlat).resolves.toMatchObject({ kind: 'dispatch' });
    expect(scheduled).not.toHaveBeenCalled();
    expect(isMirrorConfirmationRetainedForTest(topic.mirrorKey)).toBe(false);
  });

  it('keeps a live confirmation past the TTL and restarts the TTL on release', async () => {
    vi.useFakeTimers();
    const topic = await coordinateDualDelivery(input());
    await coordinateDualDelivery(input({ messageId: 'om_flat', threadId: '' }));
    if (topic.kind !== 'dispatch' || !topic.mirrorKey) throw new Error('missing mirror key');
    retainMirrorConfirmation(topic.mirrorKey);

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 1);
    await coordinateDualDelivery(
      input({ createTime: 'release-prune-trigger', messageId: 'om_release_prune_trigger' }),
    );

    releaseMirrorConfirmation(topic.mirrorKey);
    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(true);

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 1);
    await expect(waitForMirrorConfirmation(topic.mirrorKey)).resolves.toBe(false);
  });
});
