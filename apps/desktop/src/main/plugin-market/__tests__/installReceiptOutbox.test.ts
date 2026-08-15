import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PermanentPluginInstallReceiptError,
  PluginInstallReceiptOutbox,
} from '../installReceiptOutbox';

const roots: string[] = [];
const PLUGIN_ID = `c${'a'.repeat(24)}`;
const EVENT_A = '123e4567-e89b-42d3-a456-426614174000';
const EVENT_B = '223e4567-e89b-42d3-a456-426614174000';
const EVENT_C = '323e4567-e89b-42d3-a456-426614174000';

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function harness(
  send = vi.fn(async () => undefined),
  options: ConstructorParameters<typeof PluginInstallReceiptOutbox>[2] = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-install-receipts-'));
  roots.push(root);
  const directory = path.join(root, 'plugin-market', 'install-receipts.v1');
  return {
    root,
    directory,
    send,
    outbox: new PluginInstallReceiptOutbox(directory, send, options),
  };
}

describe('PluginInstallReceiptOutbox', () => {
  it('persists before sending and clears the event after an accepted receipt', async () => {
    const h = harness(undefined, { randomUUID: () => EVENT_A, retryDelaysMs: [0] });

    expect(h.outbox.enqueue(PLUGIN_ID, 'release-1')).toMatchObject({
      eventId: EVENT_A,
      pluginId: PLUGIN_ID,
      releaseId: 'release-1',
    });
    expect(h.outbox.pending()).toMatchObject([
      { eventId: EVENT_A, pluginId: PLUGIN_ID, releaseId: 'release-1' },
    ]);

    await h.outbox.flush();

    expect(h.send).toHaveBeenCalledWith({
      eventId: EVENT_A,
      pluginId: PLUGIN_ID,
      releaseId: 'release-1',
    });
    expect(h.outbox.pending()).toEqual([]);
  });

  it('reuses one eventId for every bounded network retry', async () => {
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockRejectedValueOnce(new Error('still offline'))
      .mockResolvedValueOnce(undefined);
    const wait = vi.fn(async () => undefined);
    const h = harness(send, {
      randomUUID: () => EVENT_A,
      retryDelaysMs: [0, 10, 20],
      wait,
    });
    h.outbox.enqueue(PLUGIN_ID, 'release-1');

    await h.outbox.flush();

    expect(send).toHaveBeenCalledTimes(3);
    expect(send.mock.calls.map(([receipt]) => receipt.eventId)).toEqual([
      EVENT_A,
      EVENT_A,
      EVENT_A,
    ]);
    expect(wait).toHaveBeenNthCalledWith(1, 10);
    expect(wait).toHaveBeenNthCalledWith(2, 20);
    expect(h.outbox.pending()).toEqual([]);
  });

  it('rechecks the active owner after backoff before retrying a receipt', async () => {
    let activeOwner = true;
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(undefined);
    const wait = vi.fn(async () => {
      activeOwner = false;
    });
    const h = harness(send, {
      randomUUID: () => EVENT_A,
      retryDelaysMs: [0, 10],
      shouldSend: () => activeOwner,
      wait,
    });
    h.outbox.enqueue(PLUGIN_ID, 'release-1');

    await h.outbox.flush();

    expect(wait).toHaveBeenCalledWith(10);
    expect(send).toHaveBeenCalledTimes(1);
    expect(h.outbox.pending()).toMatchObject([{ eventId: EVENT_A }]);

    activeOwner = true;
    await h.outbox.flush();

    expect(send).toHaveBeenCalledTimes(2);
    expect(h.outbox.pending()).toEqual([]);
  });

  it('keeps a failed event and a new outbox instance resends it after app restart', async () => {
    const h = harness(
      vi.fn(async () => {
        throw new Error('service unavailable');
      }),
      {
        randomUUID: () => EVENT_A,
        retryDelaysMs: [0, 1],
        wait: async () => undefined,
      },
    );
    h.outbox.enqueue(PLUGIN_ID, 'release-1');

    await h.outbox.flush();
    expect(h.outbox.pending()).toMatchObject([
      { eventId: EVENT_A, pluginId: PLUGIN_ID, releaseId: 'release-1' },
    ]);

    const restartedSend = vi.fn(async () => undefined);
    const restarted = new PluginInstallReceiptOutbox(h.directory, restartedSend, {
      retryDelaysMs: [0],
    });
    await restarted.flush();

    expect(restartedSend).toHaveBeenCalledWith({
      eventId: EVENT_A,
      pluginId: PLUGIN_ID,
      releaseId: 'release-1',
    });
    expect(restarted.pending()).toEqual([]);
  });

  it('drains more than the default 16-receipt batch during one flush', async () => {
    let sequence = 0;
    const h = harness(undefined, {
      retryDelaysMs: [0],
      randomUUID: () => `123e4567-e89b-42d3-a456-${String(sequence++).padStart(12, '0')}`,
    });
    for (let index = 0; index < 17; index += 1) {
      h.outbox.enqueue(PLUGIN_ID, `release-${index}`);
    }

    await h.outbox.flush();

    expect(h.send).toHaveBeenCalledTimes(17);
    expect(h.outbox.pending()).toEqual([]);
  });

  it('discards a permanently rejected receipt, continues, and releases queue capacity', async () => {
    const ids = [EVENT_A, EVENT_B, EVENT_C];
    const send = vi.fn(async (receipt: { eventId: string }) => {
      if (receipt.eventId === EVENT_A) {
        throw new PermanentPluginInstallReceiptError('release no longer exists');
      }
    });
    const h = harness(send, {
      maxPendingReceipts: 2,
      maxReceiptsPerFlush: 1,
      retryDelaysMs: [0, 10],
      wait: vi.fn(async () => undefined),
      randomUUID: () => ids.shift() ?? EVENT_C,
    });
    h.outbox.enqueue(PLUGIN_ID, 'deleted-release');
    h.outbox.enqueue(PLUGIN_ID, 'release-2');

    await h.outbox.flush();

    expect(send.mock.calls.map(([receipt]) => receipt.eventId)).toEqual([EVENT_A, EVENT_B]);
    expect(h.outbox.pending()).toEqual([]);
    expect(h.outbox.enqueue(PLUGIN_ID, 'release-3')).toMatchObject({ eventId: EVENT_C });
  });

  it('does not wait for a hanging request before accepting another successful install event', async () => {
    let uuid = EVENT_A;
    const send = vi.fn(() => new Promise<void>(() => undefined));
    const h = harness(send, {
      randomUUID: () => uuid,
      retryDelaysMs: [0],
    });
    h.outbox.enqueue(PLUGIN_ID, 'release-1');

    void h.outbox.flush();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    uuid = EVENT_B;

    expect(h.outbox.enqueue(PLUGIN_ID, 'release-2')).toMatchObject({ eventId: EVENT_B });
    expect(
      h.outbox
        .pending()
        .map((receipt) => receipt.eventId)
        .sort(),
    ).toEqual([EVENT_A, EVENT_B]);
  });

  it('bounds pending storage and creates a new eventId for a reinstall', () => {
    const ids = [EVENT_A, EVENT_B];
    const h = harness(undefined, {
      maxPendingReceipts: 2,
      randomUUID: () => ids.shift() ?? '323e4567-e89b-42d3-a456-426614174000',
    });

    expect(h.outbox.enqueue(PLUGIN_ID, 'release-1')?.eventId).toBe(EVENT_A);
    expect(h.outbox.enqueue(PLUGIN_ID, 'release-1')?.eventId).toBe(EVENT_B);
    expect(h.outbox.enqueue(PLUGIN_ID, 'release-1')).toBeNull();
    expect(h.outbox.pending()).toHaveLength(2);
  });
});
