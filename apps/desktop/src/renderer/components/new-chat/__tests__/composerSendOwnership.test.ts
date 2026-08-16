import { describe, expect, it } from 'vitest';

import {
  applyRefinementToSerializedText,
  applyVoiceResultToSerializedText,
  editorOwnsSourceDraft,
  mergeDetachedVoiceTextIntoDocument,
  resolveSourceOwnedComposerExtras,
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

describe('applyVoiceResultToSerializedText', () => {
  it('appends submitted or refined text when the freeze happened before ASR landed', () => {
    expect(applyVoiceResultToSerializedText('typed prefix', 'asr draft', '')).toBe(
      'typed prefix\nasr draft',
    );
    expect(applyVoiceResultToSerializedText('typed prefix', 'asr draft', 'Asr draft.')).toBe(
      'typed prefix\nAsr draft.',
    );
  });

  it('replaces a submitted span that already made it into the freeze', () => {
    expect(applyVoiceResultToSerializedText('typed asr draft', 'asr draft', 'Asr draft.')).toBe(
      'typed Asr draft.',
    );
  });
});

describe('resolveSourceOwnedComposerExtras', () => {
  it('keeps live extras while the editor still belongs to the source session', () => {
    expect(
      resolveSourceOwnedComposerExtras({
        editorOwnsSource: true,
        liveAttachments: ['live-file'],
        liveComments: ['live-comment'],
        sourceAttachments: ['source-file'],
        sourceComments: ['source-comment'],
      }),
    ).toEqual({
      attachments: ['live-file'],
      comments: ['live-comment'],
    });
  });

  it('does not send the next session extras after restoreNextDraft', () => {
    expect(
      resolveSourceOwnedComposerExtras({
        editorOwnsSource: false,
        liveAttachments: ['session-b-file'],
        liveComments: ['session-b-comment'],
        sourceAttachments: ['session-a-file'],
        sourceComments: ['session-a-comment'],
      }),
    ).toEqual({
      attachments: ['session-a-file'],
      comments: ['session-a-comment'],
    });
  });
});

describe('mergeDetachedVoiceTextIntoDocument', () => {
  it('becomes the document when the source draft is empty', () => {
    expect(mergeDetachedVoiceTextIntoDocument(null, '', 'Hello world.')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello world.' }] }],
    });
  });

  it('replaces a previously appended listening draft with the refined text', () => {
    const typed = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'typed' }] }],
    };
    const withListening = mergeDetachedVoiceTextIntoDocument(typed, '', 'asr draft');
    expect(mergeDetachedVoiceTextIntoDocument(withListening, 'asr draft', 'Asr draft.')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'typed' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Asr draft.' }] },
      ],
    });
  });
});
