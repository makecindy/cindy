// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';

import {
  insertFileMentionIntoComposer,
  subscribeFileMentionInsert,
  insertSessionLinkIntoComposer,
  subscribeSessionLinkInsert,
} from '@/lib/composerActionsBus';

describe('composerActionsBus', () => {
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

  it('delivers file mention insert requests to the target session and supports unsubscribe', () => {
    const handler = vi.fn().mockReturnValue(true);
    const unsubscribe = subscribeFileMentionInsert('session-a', handler);
    const detail = {
      targetSessionId: 'session-a',
      type: 'file' as const,
      relPath: 'src/main.ts',
      name: 'main.ts',
    };

    const accepted = insertFileMentionIntoComposer(detail);
    expect(accepted).toBe(true);
    expect(handler).toHaveBeenCalledWith(detail);

    unsubscribe();
    const acceptedAfter = insertFileMentionIntoComposer(detail);
    expect(acceptedAfter).toBe(false);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('rejects file mention insert when no handler accepts', () => {
    const handler = vi.fn().mockReturnValue(false);
    const unsubscribe = subscribeFileMentionInsert('session-b', handler);
    const detail = {
      targetSessionId: 'session-b',
      type: 'file' as const,
      relPath: 'README.md',
      name: 'README.md',
    };

    const accepted = insertFileMentionIntoComposer(detail);
    expect(accepted).toBe(false);
    expect(handler).toHaveBeenCalledWith(detail);
    unsubscribe();
  });
});
