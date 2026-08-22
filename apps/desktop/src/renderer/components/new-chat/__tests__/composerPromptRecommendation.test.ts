import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { shouldShowComposerPromptRecommendation } from '../composerPromptRecommendation';

const CHAT_INPUT_SOURCE = readFileSync(new URL('../ChatInput.tsx', import.meta.url), 'utf8');

const BASE = {
  enabled: true,
  hydrated: true,
  prompt: '继续补充测试',
  hasMessage: false,
  hasAttachments: false,
  hasBrowserComments: false,
  hasVoiceDraftText: false,
  mutationLocked: false,
};

describe('shouldShowComposerPromptRecommendation', () => {
  it('输入文字时只隐藏，重新清空后恢复同一推荐', () => {
    expect(shouldShowComposerPromptRecommendation(BASE)).toBe(true);
    expect(
      shouldShowComposerPromptRecommendation({
        ...BASE,
        hasMessage: true,
      }),
    ).toBe(false);
    expect(shouldShowComposerPromptRecommendation(BASE)).toBe(true);
  });

  it('发送路径在任何 await / clearContent 前同步消费来源 session 的推荐', () => {
    const sendStart = CHAT_INPUT_SOURCE.indexOf('const dispatchSend = useCallback');
    const dismissAt = CHAT_INPUT_SOURCE.indexOf(
      'if (sourceSessionId) dismissPromptRecommendation(sourceSessionId);',
      sendStart,
    );
    const firstAwait = CHAT_INPUT_SOURCE.indexOf(
      'await resolveSessionMessageReferencesForSend',
      sendStart,
    );
    const clearContentAt = CHAT_INPUT_SOURCE.indexOf('editor.commands.clearContent(', sendStart);

    expect(sendStart).toBeGreaterThanOrEqual(0);
    expect(dismissAt).toBeGreaterThan(sendStart);
    expect(dismissAt).toBeLessThan(firstAwait);
    expect(dismissAt).toBeLessThan(clearContentAt);
  });

  it('等待目标 session 草稿水合后才判断 candidate 是否为空输入', () => {
    expect(CHAT_INPUT_SOURCE).toContain('storageKeyForDraftRef.current !== storageKey');
    expect(CHAT_INPUT_SOURCE).toContain(
      'setComposerHydrationGeneration((generation) => generation + 1);',
    );
  });

  it('只让当前 session 拥有的语音草稿消费推荐', () => {
    expect(CHAT_INPUT_SOURCE).toContain(
      '(voiceBusyOnCurrentComposer && voiceInput.draftText.trim().length > 0)',
    );
  });

  it('session 切换的 workingDir 水合不会消费目标 session 的缓存推荐', () => {
    const hydrationAt = CHAT_INPUT_SOURCE.indexOf('setWorkingDir(initialWorkingDir ?? null);');
    const nextEditorSection = CHAT_INPUT_SOURCE.indexOf('// ── Tiptap editor', hydrationAt);
    const hydrationEffect = CHAT_INPUT_SOURCE.slice(hydrationAt, nextEditorSection);

    expect(hydrationAt).toBeGreaterThanOrEqual(0);
    expect(nextEditorSection).toBeGreaterThan(hydrationAt);
    expect(hydrationEffect).not.toContain('dismissPromptRecommendation');
  });

  it.each([
    ['开关关闭', { enabled: false }],
    ['目标 session 草稿尚未水合', { hydrated: false }],
    ['没有推荐', { prompt: null }],
    ['存在附件', { hasAttachments: true }],
    ['存在浏览器评论', { hasBrowserComments: true }],
    ['存在语音草稿', { hasVoiceDraftText: true }],
    ['输入框锁定', { mutationLocked: true }],
  ])('%s 时不显示，也不会允许隐藏推荐被 Tab 接受', (_label, patch) => {
    expect(
      shouldShowComposerPromptRecommendation({
        ...BASE,
        ...patch,
      }),
    ).toBe(false);
  });
});
