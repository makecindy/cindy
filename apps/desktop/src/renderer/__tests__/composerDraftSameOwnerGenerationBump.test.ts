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

import { afterEach, describe, expect, it } from 'vitest';

import {
  __testing as dataOwnerTesting,
  isDataOwnerGenerationCurrent,
  isDataOwnerIdCurrent,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';

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
