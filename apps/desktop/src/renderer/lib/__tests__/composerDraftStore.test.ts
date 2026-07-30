import { describe, expect, it, vi } from 'vitest';
import type { JSONContent } from '@tiptap/core';

import type { AttachedFile } from '@/lib/fileTypes';
import {
  appendQuoteToDraft,
  clearDraft,
  clearDraftAndNotify,
  draftHasContent,
  getDraft,
  getDraftPresence,
  plainTextToTiptapDoc,
  quickStartTextToTiptapDoc,
  saveDraft,
  setComposerDraftOwner,
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

/** Minimal attachment — `draftHasContent` only inspects `attachments.length`. */
const fakeAttachment: AttachedFile = {
  id: 'att-1',
  name: 'pic.png',
  path: '/tmp/pic.png',
  ext: '.png',
  size: 1,
  category: 'image',
  mimeType: 'image/png',
};

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
      expect(tn.marks).toEqual(
        expect.arrayContaining([{ type: 'quickStartPill' }]),
      );
    }
  });
});
