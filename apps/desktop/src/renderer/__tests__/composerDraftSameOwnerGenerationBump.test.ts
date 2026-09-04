/**
 * composerDraftSameOwnerGenerationBump.test.ts — 同 owner 代际跳变后输入框仍可写
 * ---------------------------------------------------------------------------
 * main 侧每次 access-token 刷新触发 Ghost projection 同 owner 修复时,会把
 * ownerGeneration +1 但 dataOwnerId 不变(2026-08-10 起)。renderer 这边没有任何
 * 东西 remount:AuthContext 只 key 在 dataOwnerId 上,composerDraftStore 的
 * 命名空间也只按 owner id 分区。ChatInput 在编辑器就位时把当时的 generation 存进
 * editorDataOwnerRef,若之后所有守卫都拿它与「当前 generation」精确比对,一次
 * 同 owner 跳变之后:
 *   - 键击草稿保存被静默丢弃;
 *   - 外部草稿写入(选中文字「添加到对话」/ rewind 预填)的订阅回调直接 return,
 *     引用永远进不了编辑器 —— 用户看到的就是「点添加到对话没反应」。
 *
 * 契约:编辑器生命周期内的持久化守卫只按 owner id 判定;真正的账号切换仍会被
 * 拦下。仅需跨运行时拆除的在途异步(乐观发送清空/恢复)才继续用精确 generation。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JSONContent } from '@tiptap/core';

import {
  __testing as dataOwnerTesting,
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerIdCurrent,
  setDataOwnerGeneration,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import {
  appendQuoteToDraft,
  clearDraft,
  getDraft,
  saveDraft,
  setComposerDraftOwner,
  subscribeDraft,
} from '@/lib/composerDraftStore';
import { COMPOSER_QUOTE_NODE_TYPE } from '@/lib/composerQuoteDocument';

const chatInput = readFileSync(
  path.join(path.resolve(__dirname, '..'), 'components/new-chat/ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

function extractBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('isDataOwnerIdCurrent', () => {
  afterEach(() => {
    dataOwnerTesting.reset();
  });

  it('stays current across a same-owner generation bump, unlike the exact check', () => {
    setDataOwnerGeneration('owner-a', 1);
    const captured = { dataOwnerId: 'owner-a', generation: 1 } as const;
    expect(isDataOwnerGenerationCurrent(captured)).toBe(true);
    expect(isDataOwnerIdCurrent(captured)).toBe(true);

    // Same owner re-committed (Ghost projection repair on token refresh).
    setDataOwnerGeneration('owner-a', 2);
    expect(isDataOwnerGenerationCurrent(captured)).toBe(false);
    expect(isDataOwnerIdCurrent(captured)).toBe(true);
  });

  it('still rejects a real owner change or sign-out boundary', () => {
    setDataOwnerGeneration('owner-a', 1);
    const captured = { dataOwnerId: 'owner-a', generation: 1 } as const;

    setDataOwnerGeneration(null);
    expect(isDataOwnerIdCurrent(captured)).toBe(false);

    setDataOwnerGeneration('owner-b');
    expect(isDataOwnerIdCurrent(captured)).toBe(false);
  });
});

/**
 * 行为层复刻(同 composerDraftMountRace.test.ts 的做法:不引入 React + Tiptap,
 * 只跑真实 composerDraftStore 数据流)。`ownerAtEditorReady` 对应 ChatInput 的
 * editorDataOwnerRef —— 编辑器就位时捕获一次,之后不再更新;三条持久化路径都
 * 拿它做守卫。守卫谓词作为参数注入,好把「修复前(精确 generation)」与
 * 「修复后(仅 owner id)」两种行为放在同一套序列下对比。
 */
type OwnerGuard = (owner: DataOwnerGeneration) => boolean;

function makeTextDoc(text: string): JSONContent {
  return { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

function docHasQuote(doc: JSONContent | null | undefined): boolean {
  if (!doc) return false;
  if (doc.type === COMPOSER_QUOTE_NODE_TYPE) return true;
  return (doc.content ?? []).some(docHasQuote);
}

function mountComposer(sessionId: string, guard: OwnerGuard) {
  const ownerAtEditorReady = getDataOwnerGeneration();
  let editorDoc: JSONContent | null = null;
  const editorSetContentCalls: JSONContent[] = [];

  // ChatInput 的外部草稿写入订阅(选中文字「添加到对话」/ rewind 预填走这里)。
  const unsubscribe = subscribeDraft(sessionId, () => {
    if (!guard(ownerAtEditorReady)) return;
    const draft = getDraft(sessionId);
    if (!draft?.text) return;
    editorDoc = draft.text;
    editorSetContentCalls.push(draft.text);
  });

  return {
    /** 用户在编辑器里敲字 → onUpdate 的 debounce 落盘。 */
    type(text: string): boolean {
      editorDoc = makeTextDoc(text);
      if (!guard(ownerAtEditorReady)) return false;
      const existing = getDraft(sessionId);
      saveDraft(
        sessionId,
        { text: editorDoc, attachments: existing?.attachments ?? [] },
        { silent: true },
      );
      return true;
    },
    /** 卸载 / 切路由时的编辑器快照。 */
    unmount(): boolean {
      unsubscribe();
      if (!guard(ownerAtEditorReady)) return false;
      const existing = getDraft(sessionId);
      if (!editorDoc && !existing) return false;
      saveDraft(
        sessionId,
        { text: editorDoc, attachments: existing?.attachments ?? [] },
        { silent: true },
      );
      return true;
    },
    get editorDoc() {
      return editorDoc;
    },
    get setContentCalls() {
      return editorSetContentCalls;
    },
  };
}

describe('composer draft flow across a same-owner generation bump', () => {
  const SESSION = 'session-quote-a';

  beforeEach(() => {
    dataOwnerTesting.reset();
    setDataOwnerGeneration('owner-a', 1);
    setComposerDraftOwner('owner-a');
    clearDraft(SESSION);
  });

  afterEach(() => {
    clearDraft(SESSION);
    setComposerDraftOwner(null);
    dataOwnerTesting.reset();
  });

  it('reproduces the bug with the exact-generation guard: quote never reaches the editor', () => {
    const composer = mountComposer(SESSION, isDataOwnerGenerationCurrent);
    expect(composer.type('hello')).toBe(true);

    // Access-token refresh → Ghost projection same-owner repair → generation +1.
    setDataOwnerGeneration('owner-a', 2);

    appendQuoteToDraft(SESSION, { text: 'selected text' });
    // The store did get the quote…
    expect(docHasQuote(getDraft(SESSION)?.text)).toBe(true);
    // …but the mounted editor never did, and typing stopped persisting too.
    expect(composer.setContentCalls).toHaveLength(0);
    expect(docHasQuote(composer.editorDoc)).toBe(false);
    expect(composer.type('hello world')).toBe(false);
    expect(composer.unmount()).toBe(false);
  });

  it('with the owner-id guard: "add to chat" and keystroke saves keep working after the bump', () => {
    const composer = mountComposer(SESSION, isDataOwnerIdCurrent);
    expect(composer.type('hello')).toBe(true);

    setDataOwnerGeneration('owner-a', 2);

    appendQuoteToDraft(SESSION, { text: 'selected text' });
    expect(composer.setContentCalls).toHaveLength(1);
    expect(docHasQuote(composer.editorDoc)).toBe(true);

    expect(composer.type('hello world')).toBe(true);
    expect(getDraft(SESSION)?.text).toEqual(makeTextDoc('hello world'));
    expect(composer.unmount()).toBe(true);
  });

  it('with the owner-id guard: a real owner change still fences the stale editor', () => {
    const composer = mountComposer(SESSION, isDataOwnerIdCurrent);
    expect(composer.type('hello')).toBe(true);

    // Sign-out boundary, then a different account signs in.
    setDataOwnerGeneration(null);
    expect(composer.type('leak?')).toBe(false);
    setDataOwnerGeneration('owner-b');
    setComposerDraftOwner('owner-b');

    appendQuoteToDraft(SESSION, { text: 'owner-b quote' });
    expect(composer.setContentCalls).toHaveLength(0);
    expect(composer.type('leak?')).toBe(false);
    expect(composer.unmount()).toBe(false);
    // owner-b's namespace only holds what owner-b wrote.
    expect(getDraft(SESSION)?.text).not.toEqual(makeTextDoc('leak?'));
    expect(docHasQuote(getDraft(SESSION)?.text)).toBe(true);
    clearDraft(SESSION);
  });
});

describe('ChatInput editor-lifetime draft guards use owner id only', () => {
  it('keystroke draft saves survive a same-owner generation bump', () => {
    const block = extractBetween(
      chatInput,
      'const dataOwnerAtSchedule = editorDataOwnerRef.current;',
      'scheduleCaretScroll(ed);',
    );
    expect(block).toContain('if (!isDataOwnerIdCurrent(dataOwnerAtSchedule)) return;');
    expect(block).not.toContain('isDataOwnerGenerationCurrent(dataOwnerAtSchedule)');
  });

  it('unmount draft snapshot survives a same-owner generation bump', () => {
    const block = extractBetween(
      chatInput,
      'const dataOwnerAtEffect = editorDataOwnerRef.current;',
      'draftSaveSchedulerRef.current?.flush();',
    );
    expect(block).toContain('if (!isDataOwnerIdCurrent(dataOwnerAtEffect))');
    expect(block).not.toContain('isDataOwnerGenerationCurrent(dataOwnerAtEffect)');
  });

  it('external draft writes (selection quote / rewind pre-fill) still reach the editor', () => {
    const block = extractBetween(
      chatInput,
      'const dataOwnerAtSubscription = editorDataOwnerRef.current;',
      'const draft = getComposerDraft(storageKey);',
    );
    expect(block).toContain('return subscribeComposerDraft(storageKey, () => {');
    expect(block).toContain('if (!isDataOwnerIdCurrent(dataOwnerAtSubscription)) return;');
    expect(block).not.toContain('isDataOwnerGenerationCurrent(dataOwnerAtSubscription)');
  });

  it('keeps the exact generation fence for the in-flight optimistic send restore', () => {
    expect(chatInput).toContain('!isDataOwnerGenerationCurrent(dataOwnerAtOptimisticClear)');
  });
});
