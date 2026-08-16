import { describe, expect, it } from 'vitest';

import {
  applyRefinementToSerializedText,
  editorOwnsSourceDraft,
  voiceLocksCurrentComposer,
} from '../composerSendOwnership';

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

describe('voiceLocksCurrentComposer', () => {
  it('locks only the session that started the in-flight voice run', () => {
    expect(
      voiceLocksCurrentComposer({
        isBusy: true,
        ownerStorageKey: 'session-a',
        currentStorageKey: 'session-a',
      }),
    ).toBe(true);
    expect(
      voiceLocksCurrentComposer({
        isBusy: true,
        ownerStorageKey: 'session-a',
        currentStorageKey: 'session-b',
      }),
    ).toBe(false);
  });

  it('does not lock after voice has settled', () => {
    expect(
      voiceLocksCurrentComposer({
        isBusy: false,
        ownerStorageKey: 'session-a',
        currentStorageKey: 'session-a',
      }),
    ).toBe(false);
  });
});

describe('applyRefinementToSerializedText', () => {
  it('replaces the last matching ASR span with the refined text', () => {
    expect(
      applyRefinementToSerializedText('prefix ASR draft ASR draft', 'ASR draft', 'Asr draft.'),
    ).toBe('prefix ASR draft Asr draft.');
  });

  it('leaves the payload unchanged when the ASR span is missing or identical', () => {
    expect(applyRefinementToSerializedText('hello', 'ASR', 'Hello.')).toBe('hello');
    expect(applyRefinementToSerializedText('hello', 'hello', 'hello')).toBe('hello');
    expect(applyRefinementToSerializedText('hello', '', 'Hello.')).toBe('hello');
  });
});
