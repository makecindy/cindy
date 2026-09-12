import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { IMAttachment } from '@cindy/im';

vi.mock('../../localDb/ipc/messages', () => ({
  createMessage: vi.fn(),
  patchMessageAgentMeta: vi.fn(async () => true),
  broadcastMessageAgentMetaUpdate: vi.fn(async () => true),
}));
vi.mock('../../messagePersistBroadcaster', () => ({
  enqueueDurableWrite: vi.fn(async (_label, write) => write('captured-owner')),
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}));

import { buildPersistedUserContent, persistUserMessage } from '../messagePersistence';
import { enqueueDurableWrite } from '../../messagePersistBroadcaster';
import {
  createMessage,
  patchMessageAgentMeta,
  broadcastMessageAgentMetaUpdate,
} from '../../localDb/ipc/messages';

beforeEach(() => vi.clearAllMocks());

describe('shared IM context persistence', () => {
  it.each(['telegram', 'feishu', 'slack', 'discord', 'wechat', 'wecom', 'dingtalk', 'future'])(
    'persists %s through the same source shape',
    async (im) => {
      const source = {
        im,
        userText: 'question',
        contextSnapshot: { groupContext: 'filtered history', replyContext: '[A] quote' },
      };
      await persistUserMessage({ sessionId: 'session', text: 'question', source });
      expect(createMessage).toHaveBeenCalledWith(
        'session',
        expect.objectContaining({
          role: 'user',
          content: 'question',
          agentMeta: { hookSource: source },
        }),
      );
      expect(patchMessageAgentMeta).not.toHaveBeenCalled();
    },
  );

  it('patches only source metadata and broadcasts the existing row without duplicating it', async () => {
    const source = { im: 'feishu', contextSnapshot: { groupContext: 'safe text' } };
    expect(
      await persistUserMessage({
        sessionId: 'session',
        text: 'question',
        source,
        existingClientId: 'early',
      }),
    ).toEqual({ clientId: 'early' });
    expect(createMessage).not.toHaveBeenCalled();
    expect(patchMessageAgentMeta).toHaveBeenCalledWith('session', 'early', { hookSource: source });
    expect(broadcastMessageAgentMetaUpdate).toHaveBeenCalledWith(
      'session',
      'early',
      'captured-owner',
    );
  });

  it('does not recreate a missing early row or broadcast a failed patch', async () => {
    vi.mocked(patchMessageAgentMeta).mockResolvedValueOnce(false);
    expect(
      await persistUserMessage({
        sessionId: 'session',
        text: 'question',
        source: { im: 'telegram' },
        existingClientId: 'gone',
      }),
    ).toBeNull();
    expect(createMessage).not.toHaveBeenCalled();
    expect(broadcastMessageAgentMetaUpdate).not.toHaveBeenCalled();
  });

  it.each(['queue', 'patch', 'broadcast'] as const)(
    'preserves the early row identity when context enrichment fails at %s',
    async (failure) => {
      const error = new Error('enrichment unavailable');
      if (failure === 'queue') vi.mocked(enqueueDurableWrite).mockRejectedValueOnce(error);
      if (failure === 'patch') vi.mocked(patchMessageAgentMeta).mockRejectedValueOnce(error);
      if (failure === 'broadcast') {
        vi.mocked(broadcastMessageAgentMetaUpdate).mockRejectedValueOnce(error);
      }

      expect(
        await persistUserMessage({
          sessionId: 'session',
          text: 'question',
          source: { im: 'wechat', contextSnapshot: { groupContext: 'safe text' } },
          existingClientId: 'early',
        }),
      ).toEqual({ clientId: 'early' });
      expect(createMessage).not.toHaveBeenCalled();
      expect(patchMessageAgentMeta).toHaveBeenCalledTimes(failure === 'queue' ? 0 : 1);
      expect(broadcastMessageAgentMetaUpdate).toHaveBeenCalledTimes(
        failure === 'broadcast' ? 1 : 0,
      );
    },
  );

  it('does not report an unpersisted new row as saved when its insert fails', async () => {
    vi.mocked(createMessage).mockRejectedValueOnce(new Error('insert failed'));
    expect(
      await persistUserMessage({ sessionId: 'session', text: 'question', source: { im: 'slack' } }),
    ).toBeNull();
    expect(patchMessageAgentMeta).not.toHaveBeenCalled();
    expect(broadcastMessageAgentMetaUpdate).not.toHaveBeenCalled();
  });

  it('does not resume an early row after the queue cancels work at an account boundary', async () => {
    vi.mocked(enqueueDurableWrite).mockRejectedValueOnce(
      Object.assign(new Error('owner changed'), { code: 'OWNER_SCOPE_SUPERSEDED' }),
    );
    expect(
      await persistUserMessage({
        sessionId: 'session',
        text: 'question',
        source: { im: 'wechat' },
        existingClientId: 'old-owner-row',
      }),
    ).toBeNull();
    expect(createMessage).not.toHaveBeenCalled();
    expect(patchMessageAgentMeta).not.toHaveBeenCalled();
    expect(broadcastMessageAgentMetaUpdate).not.toHaveBeenCalled();
  });
});

describe('IM message persistence content', () => {
  it('retains a managed file URL so message persistence pins the media blob', () => {
    const url = `cindy-media://blobs/${'a'.repeat(64)}.mp4`;
    const attachment: IMAttachment = {
      kind: 'file',
      absPath: 'C:\\managed\\clip.mp4',
      originalName: 'clip.mp4',
      mimeType: 'video/mp4',
      url,
    };

    expect(buildPersistedUserContent('', [attachment])).toEqual({
      text: '',
      images: [],
      files: [
        {
          name: 'clip.mp4',
          path: 'C:\\managed\\clip.mp4',
          url,
        },
      ],
    });
  });
});
