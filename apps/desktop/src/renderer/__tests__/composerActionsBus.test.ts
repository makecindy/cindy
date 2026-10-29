// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { getDataOwnerGeneration, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

import {
  insertSessionLinkIntoComposer,
  peekComposerSubmitRequest,
  requestComposerSubmit,
  subscribeComposerSubmitRequest,
  subscribeSessionLinkInsert,
  takeComposerSubmitRequest,
} from '@/lib/composerActionsBus';

describe('composerActionsBus', () => {
  // Unit: queued screenshot sends must not survive an account/runtime boundary.
  it.each(['same-owner', 'other-owner'])('drops queued submission after %s changes generation', change => {
    const previous = getDataOwnerGeneration();
    try {
      setDataOwnerGeneration('owner-a', 1);
      requestComposerSubmit({ storageKey: 'owner-draft', attachmentUrl: 'image:private' });
      setDataOwnerGeneration(change === 'same-owner' ? 'owner-a' : 'owner-b', 2);
      expect(peekComposerSubmitRequest('owner-draft')).toBeNull();
      expect(takeComposerSubmitRequest('owner-draft')).toBeNull();
    } finally { setDataOwnerGeneration(previous.dataOwnerId, previous.generation); }
  });
  it('delivers session-link insert requests and supports unsubscribe', () => {
    const handler = vi.fn();
    const unsubscribe = subscribeSessionLinkInsert(handler);
    const detail = {
      targetSessionId: 'session-a',
      href: 'cindy://session/session-a?message=message-a',
    };

    insertSessionLinkIntoComposer(detail);
    expect(handler).toHaveBeenCalledWith(detail);

    unsubscribe();
    insertSessionLinkIntoComposer(detail);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // 截图「翻译」等一键动作会先写草稿、再切到新任务页: 请求可能早于输入框挂载。
  // 失效后果: 请求丢失 = 点了没反应; 取走后还能再取 = 同一张截图被发两次;
  // 过期请求还生效 = 用户之后自己编辑的草稿被意外发出。
  it('keeps a submit request for a composer that mounts later, sends it once, and expires it', async () => {
    vi.useFakeTimers();
    try {
      requestComposerSubmit({ storageKey: 'draft-a', attachmentUrl: 'cindy-media://blobs/a.png' });
      const handler = vi.fn();
      const unsubscribe = subscribeComposerSubmitRequest('draft-a', handler);
      await Promise.resolve();
      expect(handler).toHaveBeenCalledTimes(1);

      expect(takeComposerSubmitRequest('draft-a')?.attachmentUrl).toBe('cindy-media://blobs/a.png');
      expect(takeComposerSubmitRequest('draft-a')).toBeNull();
      unsubscribe();

      requestComposerSubmit({ storageKey: 'draft-a', attachmentUrl: 'cindy-media://blobs/b.png' }, 1000);
      vi.advanceTimersByTime(1001);
      expect(peekComposerSubmitRequest('draft-a')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
