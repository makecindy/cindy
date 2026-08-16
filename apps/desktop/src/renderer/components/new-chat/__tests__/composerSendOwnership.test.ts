import { describe, expect, it } from 'vitest';

import { editorOwnsSourceDraft } from '../composerSendOwnership';

describe('editorOwnsSourceDraft', () => {
  it('is true while the reused editor still holds the source session document', () => {
    expect(
      editorOwnsSourceDraft({
        editorDestroyed: false,
        editorStorageKey: 'session-a',
        sourceStorageKey: 'session-a',
      }),
    ).toBe(true);
  });

  it('stays true when only the route / latest storage key has moved on', () => {
    // latestStorageKey is intentionally not an input: a pending session switch
    // that deferred restoreNextDraft must not look like a lost editor.
    expect(
      editorOwnsSourceDraft({
        editorDestroyed: false,
        editorStorageKey: 'session-a',
        sourceStorageKey: 'session-a',
      }),
    ).toBe(true);
  });

  it('is false after restoreNextDraft has swapped the editor to another session', () => {
    expect(
      editorOwnsSourceDraft({
        editorDestroyed: false,
        editorStorageKey: 'session-b',
        sourceStorageKey: 'session-a',
      }),
    ).toBe(false);
  });

  it('is false when the editor has been destroyed', () => {
    expect(
      editorOwnsSourceDraft({
        editorDestroyed: true,
        editorStorageKey: 'session-a',
        sourceStorageKey: 'session-a',
      }),
    ).toBe(false);
  });

  it('treats a matching undefined key as still owned (draft composer before a session id exists)', () => {
    expect(
      editorOwnsSourceDraft({
        editorDestroyed: false,
        editorStorageKey: undefined,
        sourceStorageKey: undefined,
      }),
    ).toBe(true);
  });
});
