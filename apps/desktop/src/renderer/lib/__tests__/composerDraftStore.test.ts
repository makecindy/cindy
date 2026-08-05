import { describe, expect, it, vi } from 'vitest';
import type { JSONContent } from '@tiptap/core';

import type { AttachedFile } from '@/lib/fileTypes';
import type { BrowserCommentDraftItem } from '@/lib/browserComments';
import {
  appendBrowserCommentToDraft,
  appendQuoteToDraft,
  captureDraftDiscardToken,
  clearDraft,
  clearDraftAndNotify,
  discardDraft,
  draftHasContent,
  getAllDraftAttachmentUrls,
  getDraft,
  getDraftPresence,
  getOrCreateRemoteOptimisticTransitionCheckpoint,
  isDraftDiscardTokenCurrent,
  plainTextToTiptapDoc,
  quickStartTextToTiptapDoc,
  removeRemoteOptimisticDraftFragment,
  restoreRemoteOptimisticDraft,
  saveDraft,
  saveComposerTextAfterAsyncTransition,
  setComposerDraftOwner,
  setRemoteOptimisticAttachmentUrls,
  subscribeDraft,
  subscribeDraftPresence,
  tiptapDocHasContent,
  type ComposerDraft,
} from '@/lib/composerDraftStore';

const emptyDoc: JSONContent = { type: 'doc', content: [{ type: 'paragraph' }] };
const whitespaceDoc: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: '   ' }] }],
};
const textDoc: JSONContent = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }],
};
const mentionDoc: JSONContent = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'mentionChip', attrs: { kind: 'file', path: 'a.ts' } }],
    },
  ],
};

const textSequenceDoc = (...values: string[]): JSONContent => ({
  type: 'doc',
  content: values.map((text) => ({
    type: 'paragraph',
    content: [{ type: 'text', text }],
  })),
});

const recoveredTextDoc = (
  recoveredValues: readonly string[],
  tailValues: readonly string[] = [],
): JSONContent => ({
  type: 'doc',
  content: [
    ...recoveredValues.flatMap((text) => [
      textSequenceDoc(text).content![0],
      { type: 'paragraph' },
    ]),
    ...(tailValues.length > 0
      ? tailValues.map((text) => textSequenceDoc(text).content![0])
      : [{ type: 'paragraph' }]),
  ],
});

const bulletListDoc = (text: string): JSONContent => ({
  type: 'doc',
  content: [
    {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
        },
      ],
    },
  ],
});

/** Minimal attachment — `draftHasContent` only inspects `attachments.length`. */
const attachment = (id: string): AttachedFile => ({
  id,
  name: `${id}.png`,
  path: `/tmp/${id}.png`,
  ext: '.png',
  size: 1,
  category: 'image',
  mimeType: 'image/png',
});
const fakeAttachment = attachment('att-1');

const browserComment = (id: string, markerNumber: number): BrowserCommentDraftItem => ({
  id,
  markerNumber,
  pageUrl: `https://example.com/${id}`,
  target: {
    kind: 'element',
    point: { x: markerNumber, y: markerNumber },
    viewport: { width: 100, height: 100 },
    region: null,
    selectedText: null,
    immediate: false,
    targetTag: 'button',
    targetLabel: id,
    targetRole: 'button',
    targetSelector: `#${id}`,
    targetPath: `html > body > #${id}`,
    nearbyText: id,
    themeVariant: 'light',
    designBaseline: null,
    markerNumber,
  },
  comment: id,
  screenshot: attachment(`${id}-shot`),
});

const draft = (over: Partial<ComposerDraft>): ComposerDraft => ({
  text: null,
  attachments: [],
  ...over,
});

describe('draftHasContent', () => {
  it('treats undefined / empty / whitespace-only as no content', () => {
    expect(draftHasContent(undefined)).toBe(false);
    expect(draftHasContent(draft({ text: null }))).toBe(false);
    expect(draftHasContent(draft({ text: emptyDoc }))).toBe(false);
    expect(draftHasContent(draft({ text: whitespaceDoc }))).toBe(false);
  });

  it('counts real text as content', () => {
    expect(draftHasContent(draft({ text: textDoc }))).toBe(true);
  });

  it('counts a mentionChip node as content (mirrors isEditorEmpty)', () => {
    expect(draftHasContent(draft({ text: mentionDoc }))).toBe(true);
  });

  it('counts attachments alone (no text) as content', () => {
    expect(draftHasContent(draft({ text: emptyDoc, attachments: [fakeAttachment] }))).toBe(true);
  });

  it('counts an inline composer quote as content', () => {
    expect(
      draftHasContent(
        draft({
          text: {
            type: 'doc',
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'composerQuote', attrs: { text: 'quoted' } }],
              },
            ],
          },
        }),
      ),
    ).toBe(true);
  });

  it('counts an empty structured list item as content', () => {
    expect(
      draftHasContent(
        draft({
          text: {
            type: 'doc',
            content: [
              {
                type: 'bulletList',
                content: [{ type: 'listItem', content: [{ type: 'paragraph' }] }],
              },
            ],
          },
        }),
      ),
    ).toBe(true);
  });
});

describe('owner isolation', () => {
  it('does not expose a New Maker draft across data-owner switches', () => {
    const key = '__new_maker_draft__';
    setComposerDraftOwner('owner-a');
    saveDraft(key, draft({ text: textDoc }));
    expect(getDraft(key)).toBeDefined();

    setComposerDraftOwner('local-v1');
    expect(getDraft(key)).toBeUndefined();

    setComposerDraftOwner('owner-a');
    expect(getDraft(key)).toBeDefined();
    clearDraft(key);
    setComposerDraftOwner(null);
  });

  it('merges current-owner draft URLs with pending remote attachment URLs', () => {
    const key = 'session-draft-live-media';
    const otherOwnerKey = 'session-other-owner-draft';
    const sharedUrl = 'cindy-media://blobs/shared.png';
    const sharedSourceUrl = 'cindy-media://blobs/shared-source.png';
    const commentUrl = 'cindy-media://blobs/comment.png';
    const commentSourceUrl = 'cindy-media://blobs/comment-source.png';
    const pendingUrl = 'cindy-media://blobs/pending.png';
    const reportDraftUrls = vi.fn();
    const previousWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        electronAPI: {
          cindyMediaStorage: { reportDraftUrls },
        },
      },
    });
    try {
      setComposerDraftOwner('owner-a');
      const comment = browserComment('draft-live-comment', 1);
      comment.screenshot = {
        ...comment.screenshot,
        url: commentUrl,
        annotationSourceUrl: commentSourceUrl,
      };
      saveDraft(
        key,
        draft({
          attachments: [
            {
              ...attachment('draft-live-media'),
              url: sharedUrl,
              annotationSourceUrl: sharedSourceUrl,
            },
          ],
          browserComments: [comment],
        }),
      );
      setRemoteOptimisticAttachmentUrls([pendingUrl, pendingUrl]);

      const expectedUrls = [pendingUrl, sharedUrl, sharedSourceUrl, commentUrl, commentSourceUrl];
      expect(getAllDraftAttachmentUrls().sort()).toEqual(expectedUrls.sort());
      expect(reportDraftUrls).toHaveBeenLastCalledWith(expect.arrayContaining(expectedUrls));

      setComposerDraftOwner('owner-b');
      saveDraft(otherOwnerKey, draft({ text: textDoc }));
      expect(getAllDraftAttachmentUrls().sort()).toEqual(expectedUrls.sort());
      expect(reportDraftUrls).toHaveBeenLastCalledWith(expect.arrayContaining(expectedUrls));
    } finally {
      setRemoteOptimisticAttachmentUrls([]);
      setComposerDraftOwner('owner-b');
      clearDraft(otherOwnerKey);
      setComposerDraftOwner('owner-a');
      clearDraft(key);
      setComposerDraftOwner(null);
      if (previousWindow === undefined) {
        Reflect.deleteProperty(globalThis, 'window');
      } else {
        Object.defineProperty(globalThis, 'window', {
          configurable: true,
          value: previousWindow,
        });
      }
    }
  });
});

describe('draft discard lifecycle', () => {
  it('invalidates async work only for explicit discard and not an ordinary clear', () => {
    const key = 'session-draft-discard-generation';
    const beforeClear = captureDraftDiscardToken(key);
    clearDraft(key);
    expect(isDraftDiscardTokenCurrent(beforeClear)).toBe(true);

    saveDraft(key, draft({ text: textDoc }));
    const beforeDiscard = captureDraftDiscardToken(key);
    const notifiedDrafts: Array<ComposerDraft | undefined> = [];
    const unsubscribe = subscribeDraft(key, () => notifiedDrafts.push(getDraft(key)));
    discardDraft(key);
    unsubscribe();

    expect(isDraftDiscardTokenCurrent(beforeDiscard)).toBe(false);
    expect(notifiedDrafts).toEqual([{ text: null, attachments: [] }]);
    expect(getDraft(key)).toBeUndefined();
  });
});

describe('remote optimistic draft recovery', () => {
  it('removes a sent prefix while preserving newer composer input', () => {
    const current = {
      text: recoveredTextDoc(['sent'], ['newer']),
      attachments: [attachment('sent-file'), attachment('newer-file')],
      browserComments: [browserComment('sent-comment', 1), browserComment('newer-comment', 2)],
    };
    const next = removeRemoteOptimisticDraftFragment(current, {
      text: textSequenceDoc('sent'),
      attachments: [attachment('sent-file')],
      browserComments: [browserComment('sent-comment', 1)],
    });

    expect(next.text).toEqual(recoveredTextDoc([], ['newer']));
    expect(next.attachments.map((file) => file.id)).toEqual(['newer-file']);
    expect(next.browserComments.map((comment) => comment.id)).toEqual(['newer-comment']);
  });

  it('does not erase text when the user edited the sent prefix', () => {
    const current = {
      text: textSequenceDoc('sent edited'),
      attachments: [attachment('sent-file'), attachment('newer-file')],
      browserComments: [],
    };
    const next = removeRemoteOptimisticDraftFragment(current, {
      text: textSequenceDoc('sent'),
      attachments: [attachment('sent-file')],
      browserComments: [],
    });

    expect(next.text).toEqual(current.text);
    expect(next.attachments.map((file) => file.id)).toEqual(['newer-file']);
  });

  it('keeps an attachment edited in place while the deferred send settles', () => {
    const edited = { ...attachment('sent-file'), name: 'renamed.png', path: '/tmp/renamed.png' };
    const next = removeRemoteOptimisticDraftFragment(
      {
        text: recoveredTextDoc([], ['newer']),
        attachments: [edited, attachment('newer-file')],
        browserComments: [],
      },
      {
        text: textSequenceDoc('sent'),
        attachments: [attachment('sent-file')],
        browserComments: [],
      },
    );

    expect(next.attachments).toEqual([edited, attachment('newer-file')]);
  });

  it('restores text, attachments, and browser comments in FIFO order before newer input', () => {
    const key = 'session-remote-recovery-fifo';
    const attachmentA = attachment('attachment-a');
    const attachmentB = attachment('attachment-b');
    const attachmentC = attachment('attachment-c');
    const commentA = browserComment('comment-a', 1);
    const commentB = browserComment('comment-b', 2);
    const commentC = browserComment('comment-c', 3);
    saveDraft(
      key,
      draft({
        text: textSequenceDoc('C'),
        attachments: [attachmentC],
        browserComments: [commentC],
      }),
      { silent: true },
    );

    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-a',
      text: textSequenceDoc('A'),
      attachments: [attachmentA],
      browserComments: [commentA],
    });
    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-b',
      text: textSequenceDoc('B'),
      attachments: [attachmentB],
      browserComments: [commentB],
    });

    expect(getDraft(key)?.text).toEqual(recoveredTextDoc(['A', 'B'], ['C']));
    expect(getDraft(key)?.attachments.map((file) => file.id)).toEqual([
      'attachment-a',
      'attachment-b',
      'attachment-c',
    ]);
    expect(getDraft(key)?.browserComments?.map((comment) => comment.id)).toEqual([
      'comment-a',
      'comment-b',
      'comment-c',
    ]);
    clearDraft(key);
  });

  it('keeps a data-owner boundary recovery batch cumulative when live state is not updated', () => {
    const key = 'session-remote-recovery-owner-boundary-batch';
    const attachmentA = attachment('attachment-a');
    const attachmentB = attachment('attachment-b');
    const attachmentC = attachment('attachment-c');
    const commentA = browserComment('comment-a', 1);
    const commentB = browserComment('comment-b', 2);
    const commentC = browserComment('comment-c', 3);
    const recoveryBatch = {};
    const staleLiveTail = {
      text: textSequenceDoc('C'),
      attachments: [attachmentC],
      browserComments: [commentC],
    };

    restoreRemoteOptimisticDraft(
      key,
      {
        clientId: 'client-a',
        text: textSequenceDoc('A'),
        attachments: [attachmentA],
        browserComments: [commentA],
      },
      staleLiveTail,
      { recoveryBatch },
    );
    restoreRemoteOptimisticDraft(
      key,
      {
        clientId: 'client-b',
        text: textSequenceDoc('B'),
        attachments: [attachmentB],
        browserComments: [commentB],
      },
      staleLiveTail,
      { recoveryBatch },
    );

    expect(getDraft(key)?.text).toEqual(recoveredTextDoc(['A', 'B'], ['C']));
    expect(getDraft(key)?.attachments.map((file) => file.id)).toEqual([
      'attachment-a',
      'attachment-b',
      'attachment-c',
    ]);
    expect(getDraft(key)?.browserComments?.map((comment) => comment.id)).toEqual([
      'comment-a',
      'comment-b',
      'comment-c',
    ]);
    clearDraft(key);
  });

  it('keeps consecutive compatible list fragments in FIFO order', () => {
    const key = 'session-remote-recovery-list-fifo';
    saveDraft(key, draft({ text: bulletListDoc('C') }), { silent: true });

    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-a',
      text: bulletListDoc('A'),
      attachments: [],
      browserComments: [],
    });
    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-b',
      text: bulletListDoc('B'),
      attachments: [],
      browserComments: [],
    });

    expect(getDraft(key)?.text?.content).toEqual([
      bulletListDoc('A').content![0],
      { type: 'paragraph' },
      bulletListDoc('B').content![0],
      { type: 'paragraph' },
      bulletListDoc('C').content![0],
    ]);
    clearDraft(key);
  });

  it('keeps each recovery cursor independent when one draft domain changes', () => {
    const key = 'session-remote-recovery-independent-cursors';
    const attachmentA = attachment('attachment-a');
    const attachmentB = attachment('attachment-b');
    const attachmentC = attachment('attachment-c');
    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-a',
      text: textSequenceDoc('A'),
      attachments: [attachmentA],
      browserComments: [],
    });
    saveDraft(
      key,
      draft({
        text: recoveredTextDoc(['A'], ['C']),
        attachments: [attachmentC],
      }),
      { silent: true },
    );

    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-b',
      text: textSequenceDoc('B'),
      attachments: [attachmentB],
      browserComments: [],
    });

    expect(getDraft(key)?.text).toEqual(recoveredTextDoc(['A', 'B'], ['C']));
    expect(getDraft(key)?.attachments.map((file) => file.id)).toEqual([
      'attachment-b',
      'attachment-c',
    ]);
    clearDraft(key);
  });

  it('keeps FIFO recovery after incremental quote and browser comment appends', () => {
    const key = 'session-remote-recovery-incremental-appends';
    const commentA = browserComment('comment-a', 1);
    const commentB = browserComment('comment-b', 2);
    const commentC = browserComment('comment-c', 3);
    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-a',
      text: textSequenceDoc('A'),
      attachments: [],
      browserComments: [commentA],
    });

    appendQuoteToDraft(key, { text: 'C quote' });
    appendBrowserCommentToDraft(key, commentC);
    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-b',
      text: textSequenceDoc('B'),
      attachments: [],
      browserComments: [commentB],
    });

    expect(getDraft(key)?.text?.content).toEqual([
      textSequenceDoc('A').content![0],
      { type: 'paragraph' },
      textSequenceDoc('B').content![0],
      { type: 'paragraph' },
      {
        type: 'paragraph',
        content: [
          {
            type: 'composerQuote',
            attrs: {
              text: 'C quote',
              sourcePath: null,
              startLine: null,
              endLine: null,
            },
          },
        ],
      },
    ]);
    expect(getDraft(key)?.browserComments?.map((comment) => comment.id)).toEqual([
      'comment-a',
      'comment-b',
      'comment-c',
    ]);
    clearDraft(key);
  });

  it('preserves recoveries when the same async editor transition reruns while voice settles', () => {
    const key = 'session-remote-recovery-async-transition';
    const attachmentA = attachment('attachment-a');
    const attachmentB = attachment('attachment-b');
    const attachmentC = attachment('attachment-c');
    const commentA = browserComment('comment-a', 1);
    const commentB = browserComment('comment-b', 2);
    const commentC = browserComment('comment-c', 3);
    saveDraft(
      key,
      draft({
        text: textSequenceDoc('C'),
        attachments: [attachmentC],
        browserComments: [commentC],
      }),
      { silent: true },
    );
    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-a',
      text: textSequenceDoc('A'),
      attachments: [attachmentA],
      browserComments: [commentA],
    });
    const transition = getOrCreateRemoteOptimisticTransitionCheckpoint(null, key);
    const delayedEditorSnapshot = getDraft(key)?.text ?? null;

    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-b',
      text: textSequenceDoc('B'),
      attachments: [attachmentB],
      browserComments: [commentB],
    });
    const repeatedTransition = getOrCreateRemoteOptimisticTransitionCheckpoint(transition, key);
    expect(repeatedTransition).toBe(transition);
    saveComposerTextAfterAsyncTransition(key, delayedEditorSnapshot, repeatedTransition.checkpoint);

    expect(getDraft(key)?.text).toEqual(recoveredTextDoc(['A', 'B'], ['C']));
    expect(getDraft(key)?.attachments.map((file) => file.id)).toEqual([
      'attachment-a',
      'attachment-b',
      'attachment-c',
    ]);
    expect(getDraft(key)?.browserComments?.map((comment) => comment.id)).toEqual([
      'comment-a',
      'comment-b',
      'comment-c',
    ]);
    clearDraft(key);
  });

  it('ignores a duplicate clientId', () => {
    const key = 'session-remote-recovery-idempotent';
    const fragment = {
      clientId: 'client-a',
      text: textSequenceDoc('A'),
      attachments: [attachment('attachment-a')],
      browserComments: [browserComment('comment-a', 1)],
    };

    restoreRemoteOptimisticDraft(key, fragment);
    restoreRemoteOptimisticDraft(key, fragment);

    expect(getDraft(key)?.text).toEqual(recoveredTextDoc(['A']));
    expect(getDraft(key)?.attachments.map((file) => file.id)).toEqual(['attachment-a']);
    expect(getDraft(key)?.browserComments?.map((comment) => comment.id)).toEqual(['comment-a']);
    clearDraft(key);
  });

  it('keeps the recovery cursor when the user adds newer input between failures', () => {
    const key = 'session-remote-recovery-live-input';
    const attachmentA = attachment('attachment-a');
    const attachmentB = attachment('attachment-b');
    const attachmentC = attachment('attachment-c');
    const commentA = browserComment('comment-a', 1);
    const commentB = browserComment('comment-b', 2);
    const commentC = browserComment('comment-c', 3);

    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-a',
      text: textSequenceDoc('A'),
      attachments: [attachmentA],
      browserComments: [commentA],
    });
    saveDraft(
      key,
      draft({
        text: recoveredTextDoc(['A'], ['C']),
        attachments: [attachmentA, attachmentC],
        browserComments: [commentA, commentC],
      }),
      { silent: true },
    );
    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-b',
      text: textSequenceDoc('B'),
      attachments: [attachmentB],
      browserComments: [commentB],
    });

    expect(getDraft(key)?.text).toEqual(recoveredTextDoc(['A', 'B'], ['C']));
    expect(getDraft(key)?.attachments.map((file) => file.id)).toEqual([
      'attachment-a',
      'attachment-b',
      'attachment-c',
    ]);
    expect(getDraft(key)?.browserComments?.map((comment) => comment.id)).toEqual([
      'comment-a',
      'comment-b',
      'comment-c',
    ]);
    clearDraft(key);
  });

  it('treats an explicit empty live override as authoritative over a stale saved draft', () => {
    const key = 'session-remote-recovery-live-empty';
    saveDraft(key, draft({ text: textSequenceDoc('stale') }), { silent: true });

    restoreRemoteOptimisticDraft(
      key,
      {
        clientId: 'client-a',
        text: textSequenceDoc('A'),
        attachments: [],
        browserComments: [],
      },
      { text: null, attachments: [], browserComments: [] },
    );

    expect(getDraft(key)?.text).toEqual(recoveredTextDoc(['A']));
    clearDraft(key);
  });

  it('resets recovery cursors after clear or an external draft replacement', () => {
    const key = 'session-remote-recovery-reset';
    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-a',
      text: textSequenceDoc('A'),
      attachments: [attachment('attachment-a')],
      browserComments: [browserComment('comment-a', 1)],
    });
    clearDraft(key);
    saveDraft(key, draft({ text: textSequenceDoc('C') }), { silent: true });
    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-b',
      text: textSequenceDoc('B'),
      attachments: [],
      browserComments: [],
    });
    expect(getDraft(key)?.text).toEqual(recoveredTextDoc(['B'], ['C']));

    saveDraft(key, draft({ text: textSequenceDoc('replacement') }));
    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-c',
      text: textSequenceDoc('C'),
      attachments: [],
      browserComments: [],
    });
    expect(getDraft(key)?.text).toEqual(recoveredTextDoc(['C'], ['replacement']));
    clearDraft(key);
  });

  it('isolates recovery state by owner and storage key', () => {
    const sharedKey = 'session-remote-recovery-owner';
    setComposerDraftOwner('owner-a');
    restoreRemoteOptimisticDraft(sharedKey, {
      clientId: 'client-a',
      text: textSequenceDoc('owner-a'),
      attachments: [],
      browserComments: [],
    });
    restoreRemoteOptimisticDraft(`${sharedKey}-other`, {
      clientId: 'client-other',
      text: textSequenceDoc('other-key'),
      attachments: [],
      browserComments: [],
    });

    setComposerDraftOwner('owner-b');
    expect(getDraft(sharedKey)).toBeUndefined();
    restoreRemoteOptimisticDraft(sharedKey, {
      clientId: 'client-b',
      text: textSequenceDoc('owner-b'),
      attachments: [],
      browserComments: [],
    });
    expect(getDraft(sharedKey)?.text).toEqual(recoveredTextDoc(['owner-b']));

    setComposerDraftOwner('owner-a');
    expect(getDraft(sharedKey)?.text).toEqual(recoveredTextDoc(['owner-a']));
    expect(getDraft(`${sharedKey}-other`)?.text).toEqual(recoveredTextDoc(['other-key']));
    clearDraft(sharedKey);
    clearDraft(`${sharedKey}-other`);
    setComposerDraftOwner('owner-b');
    clearDraft(sharedKey);
    setComposerDraftOwner(null);
  });

  it('notifies a newly mounted owner when recovery happens without a live override', () => {
    const key = 'session-remote-recovery-background-notify';
    const listener = vi.fn();
    const unsubscribe = subscribeDraft(key, listener);

    restoreRemoteOptimisticDraft(key, {
      clientId: 'client-a',
      text: textSequenceDoc('A'),
      attachments: [],
      browserComments: [],
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(getDraft(key)?.text).toEqual(recoveredTextDoc(['A']));
    unsubscribe();
    clearDraft(key);
  });
});

describe('appendQuoteToDraft', () => {
  it('lifts legacy quote arrays into leading inline nodes', () => {
    const id = 'session-legacy-quote';
    saveDraft(
      id,
      draft({
        text: textDoc,
        quotes: [{ text: 'legacy quote', sourcePath: 'legacy.ts' }],
      }),
    );

    expect(getDraft(id)?.text?.content).toEqual([
      {
        type: 'paragraph',
        content: [
          {
            type: 'composerQuote',
            attrs: {
              text: 'legacy quote',
              sourcePath: 'legacy.ts',
              startLine: null,
              endLine: null,
            },
          },
          { type: 'text', text: 'hello' },
        ],
      },
    ]);
    expect(getDraft(id)?.quotes).toEqual([]);
    clearDraft(id);
  });

  it('preserves the ordered body while appending a new inline quote', () => {
    const id = 'session-append-quote';
    saveDraft(id, draft({ text: textDoc }));

    appendQuoteToDraft(id, { text: 'new quote', startLine: 4, endLine: 5 });

    expect(getDraft(id)).toEqual({
      text: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'hello' },
              {
                type: 'composerQuote',
                attrs: {
                  text: 'new quote',
                  sourcePath: null,
                  startLine: 4,
                  endLine: 5,
                },
              },
            ],
          },
        ],
      },
      attachments: [],
      quotes: [],
      browserComments: [],
    });
    clearDraft(id);
  });
});

describe('draft presence subscription', () => {
  it('notifies once when a draft flips empty → non-empty, then exposes true', () => {
    const id = 'session-presence-1';
    const cb = vi.fn();
    const unsub = subscribeDraftPresence(id, cb);

    expect(getDraftPresence(id)).toBe(false);

    saveDraft(id, draft({ text: textDoc }), { silent: true });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getDraftPresence(id)).toBe(true);

    // A subsequent keystroke save that stays non-empty must NOT re-notify.
    saveDraft(id, draft({ text: { ...textDoc } }), { silent: true });
    expect(cb).toHaveBeenCalledTimes(1);

    clearDraft(id);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(getDraftPresence(id)).toBe(false);

    unsub();
    clearDraft(id);
  });

  it('fires presence even for silent saves (sidebar must see keystroke saves)', () => {
    const id = 'session-presence-2';
    const cb = vi.fn();
    const unsub = subscribeDraftPresence(id, cb);

    saveDraft(id, draft({ attachments: [fakeAttachment] }), { silent: true });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getDraftPresence(id)).toBe(true);

    unsub();
    clearDraft(id);
  });

  it('stops notifying after unsubscribe', () => {
    const id = 'session-presence-3';
    const cb = vi.fn();
    const unsub = subscribeDraftPresence(id, cb);
    unsub();

    saveDraft(id, draft({ text: textDoc }), { silent: true });
    expect(cb).not.toHaveBeenCalled();

    clearDraft(id);
  });

  it('clearDraftAndNotify flips presence to false and notifies once, even with a content listener registered', () => {
    // Covers clearDraftAndNotify's distinct path: it stages an empty draft +
    // notifies the CONTENT listeners (subscribeDraft) first, then deletes and
    // calls recomputeDraftPresence. We register both a content listener (to hit
    // the size>0 staging branch) and a presence listener, and assert the
    // presence side sees exactly one true→false transition.
    const id = 'session-presence-4';
    const presenceCb = vi.fn();
    const contentCb = vi.fn();
    const unsubPresence = subscribeDraftPresence(id, presenceCb);
    const unsubContent = subscribeDraft(id, contentCb);

    saveDraft(id, draft({ text: textDoc }), { silent: true });
    expect(presenceCb).toHaveBeenCalledTimes(1);
    expect(getDraftPresence(id)).toBe(true);

    clearDraftAndNotify(id);
    // content listener fired by the staging branch; presence flipped true→false.
    expect(contentCb).toHaveBeenCalledTimes(1);
    expect(presenceCb).toHaveBeenCalledTimes(2);
    expect(getDraftPresence(id)).toBe(false);

    // Idempotent: a second clearDraftAndNotify on an already-empty session does
    // not re-notify presence (no false→false transition).
    clearDraftAndNotify(id);
    expect(presenceCb).toHaveBeenCalledTimes(2);

    unsubPresence();
    unsubContent();
  });

  // ChatInput 的外部草稿订阅用这个判空把「空文档 JSON」折叠成 null,再与
  // 「编辑器为空」比较。两侧口径不一致时,每次外部草稿通知都会拿一份空文档整段
  // setContent,把按位置存活的编辑器状态(语音草稿锚点)连带重建 —— 语音录音时
  // 首行多出一个空行就是这么来的。
  it('treats an empty / whitespace-only document as having no content', () => {
    expect(tiptapDocHasContent(emptyDoc)).toBe(false);
    expect(tiptapDocHasContent(whitespaceDoc)).toBe(false);
    expect(tiptapDocHasContent(null)).toBe(false);
    expect(tiptapDocHasContent(textDoc)).toBe(true);
    expect(tiptapDocHasContent(mentionDoc)).toBe(true);
  });
});

describe('quickStartTextToTiptapDoc', () => {
  it('returns empty doc for empty string', () => {
    expect(quickStartTextToTiptapDoc('')).toEqual(emptyDoc);
  });

  it('wraps single-line text with quickStartPill mark', () => {
    const doc = quickStartTextToTiptapDoc('探索并理解代码');
    expect(doc.type).toBe('doc');
    expect(doc.content).toHaveLength(1);
    const para = doc.content![0];
    expect(para.type).toBe('paragraph');
    expect(para.content).toHaveLength(1);
    const textNode = para.content![0];
    expect(textNode.type).toBe('text');
    expect(textNode.text).toBe('探索并理解代码');
    expect(textNode.marks).toEqual([{ type: 'quickStartPill' }]);
  });

  it('applies mark to each line in multi-line text', () => {
    const doc = quickStartTextToTiptapDoc('line1\nline2');
    expect(doc.content).toHaveLength(2);
    for (const para of doc.content!) {
      if (para.content) {
        for (const node of para.content) {
          expect(node.marks).toEqual([{ type: 'quickStartPill' }]);
        }
      }
    }
  });

  it('preserves empty lines as empty paragraphs (no mark)', () => {
    const doc = quickStartTextToTiptapDoc('a\n\nb');
    expect(doc.content).toHaveLength(3);
    expect(doc.content![1].content).toBeUndefined();
  });

  it('differs from plainTextToTiptapDoc by having marks', () => {
    const plain = plainTextToTiptapDoc('hello');
    const marked = quickStartTextToTiptapDoc('hello');
    const plainText = plain.content![0].content![0];
    const markedText = marked.content![0].content![0];
    expect(plainText.marks).toBeUndefined();
    expect(markedText.marks).toEqual([{ type: 'quickStartPill' }]);
  });

  it('goes through plainText normalization (lists become bulletList nodes) and marks leaf text', () => {
    const doc = quickStartTextToTiptapDoc('- item1\n- item2');
    // Walk tree to find every text node; they must all carry quickStartPill mark.
    const textNodes: { text?: string; marks?: unknown[] }[] = [];
    const walk = (n: JSONContent) => {
      if (n.type === 'text') textNodes.push({ text: n.text, marks: n.marks });
      (n.content ?? []).forEach(walk);
    };
    walk(doc);
    expect(textNodes.length).toBeGreaterThanOrEqual(2);
    for (const tn of textNodes) {
      expect(tn.marks).toEqual(expect.arrayContaining([{ type: 'quickStartPill' }]));
    }
  });
});
