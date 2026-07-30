import { randomBytes } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import type { DbClient } from '../../../localDb/client/DbClient.js';
import { encryptWechatContextToken } from '../contextCrypto.js';
import { WechatTaskStore } from '../taskStore.js';

describe('WechatTaskStore', () => {
  it('encrypts context before crossing the DbClient boundary and applies the 30 minute TTL', async () => {
    const tx = vi.fn().mockResolvedValue({
      committed: true,
      insertedTaskIds: ['task-1'],
      duplicateTaskIds: [],
      rejectedTaskIds: [],
    });
    const store = new WechatTaskStore(fakeDb(tx), randomBytes(32));

    await store.commitPollBatch({
      bindingEpoch: 'epoch-1',
      expectedCursor: '',
      nextCursor: 'cursor-1',
      now: 100,
      messages: [
        {
          id: 'task-1',
          platformMessageId: 'platform-1',
          platformSeq: 1,
          peerId: 'peer-1',
          receivedAt: 100,
          platformCreatedAt: 90,
          sessionId: 'session-1',
          conversationEpoch: 0,
          payloadJson: '{"text":"hello"}',
          contextToken: 'plain-context-secret',
        },
      ],
    });

    const [, args] = tx.mock.calls[0] as [string, Record<string, unknown>];
    expect(tx.mock.calls[0]?.[0]).toBe('wechatCommitPollBatch');
    expect(JSON.stringify(args)).not.toContain('plain-context-secret');
    expect(args.messages).toEqual([
      expect.objectContaining({
        id: 'task-1',
        expiresAt: 1_800_100,
        context: {
          nonce: expect.any(String),
          ciphertext: expect.any(String),
          tag: expect.any(String),
        },
      }),
    ]);
  });

  it('decrypts a leased task only inside the main-process store', async () => {
    const key = randomBytes(32);
    const tx = vi.fn().mockResolvedValue({
      id: 'task-1',
      bindingEpoch: 'epoch-1',
      peerId: 'peer-1',
      sessionId: 'session-1',
      conversationEpoch: 0,
      payloadJson: '{}',
      context: encryptWechatContextToken('plain-context-secret', key, 'epoch-1', 'task-1'),
      attempts: 1,
      receivedAt: 100,
      expiresAt: 1_800_100,
    });
    const store = new WechatTaskStore(fakeDb(tx), key);

    await expect(store.leaseNextTask({ bindingEpoch: 'epoch-1', now: 200 })).resolves.toMatchObject(
      {
        id: 'task-1',
        contextToken: 'plain-context-secret',
      },
    );
  });

  it('returns decrypted context with each due durable outbox item', async () => {
    const key = randomBytes(32);
    const encrypted = encryptWechatContextToken('fresh-send-context', key, 'epoch-1', 'task-1');
    const query = vi.fn().mockResolvedValue([
      {
        id: 'outbox-1',
        bindingEpoch: 'epoch-1',
        taskId: 'task-1',
        clientId: 'client-1',
        kind: 'final',
        chunkIndex: 0,
        text: 'done',
        mediaJson: '[]',
        attempts: 0,
        contextNonce: encrypted.nonce,
        contextCiphertext: encrypted.ciphertext,
        contextTag: encrypted.tag,
      },
    ]);
    const store = new WechatTaskStore(fakeDb(vi.fn(), query), key);

    await expect(store.listDueOutbox('epoch-1', 200)).resolves.toEqual([
      expect.objectContaining({
        id: 'outbox-1',
        contextToken: 'fresh-send-context',
      }),
    ]);
  });

  it('re-encrypts a newer peer token separately for every pending reply task', async () => {
    const tx = vi.fn().mockResolvedValue({ refreshedTasks: 2, outboxWoken: 2 });
    const query = vi.fn().mockResolvedValue([
      { taskId: 'task-1' },
      { taskId: 'task-2' },
    ]);
    const store = new WechatTaskStore(fakeDb(tx, query), randomBytes(32));

    await store.refreshPendingOutboxContext({
      bindingEpoch: 'epoch-1',
      peerId: 'peer-1',
      contextToken: 'new-peer-context',
      now: 300,
    });

    expect(tx).toHaveBeenCalledWith(
      'wechatRefreshOutboxContexts',
      expect.objectContaining({
        bindingEpoch: 'epoch-1',
        peerId: 'peer-1',
        contexts: [
          { taskId: 'task-1', context: expect.any(Object) },
          { taskId: 'task-2', context: expect.any(Object) },
        ],
      }),
    );
    expect(JSON.stringify(tx.mock.calls[0]?.[1])).not.toContain('new-peer-context');
  });
});

function fakeDb(tx: ReturnType<typeof vi.fn>, query: ReturnType<typeof vi.fn> = vi.fn()): DbClient {
  return {
    tx,
    query,
    queryOne: vi.fn(),
    exec: vi.fn(),
    drizzle: {} as DbClient['drizzle'],
    vecAvailable: false,
    dispose: vi.fn(),
  } as unknown as DbClient;
}
