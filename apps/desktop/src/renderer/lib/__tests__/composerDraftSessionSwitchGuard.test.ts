import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';

import { createComposerDraftSaveScheduler } from '@/lib/composerDraftSaveScheduler';
import { getDraft, saveDraft } from '@/lib/composerDraftStore';

/**
 * Regression test for the voice-input/session-switch draft corruption fix in
 * ChatInput.tsx's Tiptap `onUpdate` handler.
 *
 * Background: to avoid serializing the editor's JSON on every keystroke,
 * `onUpdate` captures the storage key (`sk`) eagerly but defers the
 * `editor.getJSON()` read into a short debounce, via the real
 * `createComposerDraftSaveScheduler` (perf win this suite must keep). During a
 * voice-input stop/refine/send transaction, ChatInput intentionally lets
 * `storageKeyForDraftRef` lag behind the `storageKey` prop until that async
 * work settles. ChatInput reuses a single Tiptap editor instance across
 * session switches, so if the debounce timer for an old-session update is
 * still pending when the async transition finishes and swaps that same
 * editor over to the next session's document, a naive scheduled task would
 * read the NEXT session's content via the deferred `ed.getJSON()` call but
 * persist it under the OLD session's storage key — corrupting the old
 * session's draft with the new session's text.
 *
 * The fix re-checks, at the moment the debounce timer actually fires,
 * whether `storageKeyForDraftRef.current` still equals the `sk` the task was
 * scheduled for; a mismatch means the editor's content no longer belongs to
 * `sk` and the write is skipped.
 */

const chatInputSource = readFileSync(
  resolve(__dirname, '..', '..', 'components', 'new-chat', 'ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('ChatInput scheduled draft-save session-switch guard', () => {
  it('pins the production guard in onUpdate so this regression test cannot silently drift from ChatInput.tsx', () => {
    const scheduledSaveBlock = extractBetween(
      chatInputSource,
      'const sk = storageKeyForDraftRef.current;',
      '// chat-input-autoscroll fix:',
    );

    expect(scheduledSaveBlock).toContain('draftSaveSchedulerRef.current?.schedule(() => {');
    expect(scheduledSaveBlock).toContain('if (storageKeyForDraftRef.current !== sk) return;');
    expect(scheduledSaveBlock).toContain('text: ed.getJSON(),');
    // The re-check must guard the deferred read, not run after it. Search
    // from the start of the `.schedule(...)` callback body (not the
    // explanatory comment above it, which also mentions `ed.getJSON()`) so
    // this only inspects the actual guarded code shape.
    const scheduleCallbackStart = scheduledSaveBlock.indexOf(
      'draftSaveSchedulerRef.current?.schedule(() => {',
    );
    const callbackBody = scheduledSaveBlock.slice(scheduleCallbackStart);
    expect(callbackBody.indexOf('storageKeyForDraftRef.current !== sk')).toBeLessThan(
      callbackBody.indexOf('ed.getJSON()'),
    );
  });

  it('does not corrupt the old session draft when the debounce timer fires after a session switch completed mid-flight (voice-input stop/refine/send race)', () => {
    const timers: Array<() => void> = [];
    const scheduler = createComposerDraftSaveScheduler({
      setTimer: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimer: () => undefined,
    });

    const oldKey = 'session-switch-guard-old';
    const newKey = 'session-switch-guard-new';
    const oldFinalDoc: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'old session final text' }] }],
    };
    const newSessionDoc: JSONContent = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'next session draft' }] }],
    };

    // One shared, mutable Tiptap-editor stand-in: ChatInput reuses a single
    // editor instance across session switches, so a deferred `ed.getJSON()`
    // always reflects whatever document currently lives in the editor — not
    // whatever it held back when the task was scheduled.
    const editorDoc = { current: oldFinalDoc };
    // Mirrors `storageKeyForDraftRef` — flips only when `restoreNextDraft`
    // actually swaps the editor's content over to the next session.
    const storageKeyForDraftRef = { current: oldKey as string | undefined };

    // Seed the "old" session's draft as if the user had already typed
    // `oldFinalDoc` and ChatInput's synchronous `saveCurrentEditorDraft()`
    // (unrelated to the debounce path) had already persisted it correctly.
    saveDraft(oldKey, { text: oldFinalDoc, attachments: [], quotes: [], browserComments: [] });
    // Seed the "new" session's own, independent draft.
    saveDraft(newKey, { text: newSessionDoc, attachments: [], quotes: [], browserComments: [] });

    // onUpdate fires once more for the OLD session right before the voice
    // stop/refine/send transaction resolves: capture `sk` eagerly, schedule
    // the deferred read/write — exactly the production `onUpdate` shape.
    const sk = storageKeyForDraftRef.current;
    expect(sk).toBe(oldKey);
    scheduler.schedule(() => {
      if (storageKeyForDraftRef.current !== sk) return;
      const existing = getDraft(sk!);
      saveDraft(
        sk!,
        {
          text: editorDoc.current,
          attachments: existing?.attachments ?? [],
          quotes: existing?.quotes ?? [],
          browserComments: existing?.browserComments ?? [],
        },
        { silent: true },
      );
    });
    expect(timers).toHaveLength(1);

    // The async voice transition now finishes: production's
    // `restoreNextDraft()` swaps the shared editor's content over to the
    // next session's document and flips the tracked storage key — all
    // BEFORE the debounce timer above has fired.
    editorDoc.current = newSessionDoc;
    storageKeyForDraftRef.current = newKey;

    // Debounce timer fires late, after the switch already completed.
    timers[0]?.();

    // The guard must have skipped the write: the old session's draft keeps
    // its correct final content instead of being overwritten with the new
    // session's document.
    expect(getDraft(oldKey)?.text).toEqual(oldFinalDoc);
    // The new session's own draft (populated by the real restore path, not
    // this stale task) must also remain untouched.
    expect(getDraft(newKey)?.text).toEqual(newSessionDoc);
  });

  it('still saves normally when the debounce timer fires before any session switch', () => {
    const timers: Array<() => void> = [];
    const scheduler = createComposerDraftSaveScheduler({
      setTimer: (callback) => {
        timers.push(callback);
        return timers.length;
      },
      clearTimer: () => undefined,
    });

    const key = 'session-switch-guard-no-race';
    const typedDoc: JSONContent = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'typed while still on this session' }] },
      ],
    };
    const editorDoc = { current: typedDoc };
    const storageKeyForDraftRef = { current: key as string | undefined };

    const sk = storageKeyForDraftRef.current;
    scheduler.schedule(() => {
      if (storageKeyForDraftRef.current !== sk) return;
      const existing = getDraft(sk!);
      saveDraft(
        sk!,
        {
          text: editorDoc.current,
          attachments: existing?.attachments ?? [],
          quotes: existing?.quotes ?? [],
          browserComments: existing?.browserComments ?? [],
        },
        { silent: true },
      );
    });
    timers[0]?.();

    expect(getDraft(key)?.text).toEqual(typedDoc);
  });
});

function extractBetween(source: string, startNeedle: string, endNeedle: string): string {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}
