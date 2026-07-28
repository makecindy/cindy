/**
 * composerExternalDraftEmptyDoc.test.ts — 外部草稿通知的「空文档」判空口径
 * ---------------------------------------------------------------------------
 * ChatInput 订阅 composerDraftStore 的外部写入后,只有在草稿正文与编辑器当前
 * 文档真的不同时才做全量 setContent。草稿正文在存储里是 Tiptap JSON:空草稿
 * 常常是 `{doc:[空 paragraph]}` 而不是 `null`,而比较的另一侧对「编辑器为空」
 * 一律折叠成 `null`。两侧口径不一致时,每条外部通知都会拿一份空文档原地重建
 * doc(`replace(0, size)`),把所有按位置存活的编辑器状态强行跨整篇映射——语音
 * 录音时 caret 锚点被推出段落、首行多一个空行就是这么来的。
 *
 * 契约锁在源码层:该分支必须用 composerDraftStore 的判空把空文档折叠成 null,
 * 不能只判断 `draft.text` 是否存在。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// CRLF 归一化:Windows checkout 下源码带 \r\n,否则跨 checkout 断言会假失败
// (同 chatInputSessionFocus 等既有源码契约测试)。
const chatInput = readFileSync(
  path.join(path.resolve(__dirname, '..'), 'components/new-chat/ChatInput.tsx'),
  'utf8',
).replace(/\r\n?/g, '\n');

describe('external draft notification empty-document handling', () => {
  it('collapses an empty draft document to null before comparing with the editor', () => {
    const start = chatInput.indexOf('return subscribeComposerDraft(storageKey, () => {');
    expect(start).toBeGreaterThan(-1);
    // 两个锚点都必须真实命中:end 缺失时 indexOf 返回 -1,slice(start, -1) 会切出
    // 一大段无关源码,让下面的 toContain 假通过、契约形同失效。
    const end = chatInput.indexOf('const textUnchanged', start);
    expect(end).toBeGreaterThan(start);
    const block = chatInput.slice(start, end);

    expect(block).toContain('normalizeComposerDocumentJSON(draft.text)');
    // 判空必须走共享实现,与 draftHasContent / isEditorEmpty 同源。
    expect(block).toContain('tiptapDocHasContent(');
    expect(block).not.toMatch(/const normalizedDraftText = draft\.text\s*\n?\s*\?/);
  });

  // 同一口径也必须覆盖 storageKey 对齐分支:它依赖 voiceInput.isBusy,录音开始与
  // 结束各重跑一次。漏判空时新建对话页(草稿键固定、常留一份空正文)会在语音结束
  // 时重建 doc,把插入点推到 block 边界 —— 上屏文字前多一个空行。
  it('also collapses an empty draft document on the storageKey-aligned hydration path', () => {
    const start = chatInput.indexOf('// First-mount hydration path');
    expect(start).toBeGreaterThan(-1);
    const end = chatInput.indexOf('editorStorageKeyRef.current = storageKey;', start);
    expect(end).toBeGreaterThan(start);
    const block = chatInput.slice(start, end);

    expect(block).toContain('tiptapDocHasContent(draft.text)');
    expect(block).toContain('composerDocIsEmpty(editor.state.doc)');
    // 不能再直接拿 draft.text 当"有草稿"的判据。
    expect(block).not.toMatch(/if \(draft\?\.text && composerDocIsEmpty/);
  });
});
