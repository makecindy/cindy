import { describe, expect, it } from 'vitest';
import {
  CONTINUE_AFTER_APP_EXIT_PROMPT,
  CONTINUE_AFTER_ERROR_PROMPT,
  UI_ACTION_TRIGGER_PREFIX,
  isSyntheticTriggerText,
  isContinuationMessage,
  syntheticTriggerKind,
} from '../syntheticTrigger.js';

describe('synthetic trigger detection', () => {
  it('recognizes recovery in raw and hidden projections without treating every trigger as recovery', () => {
    for (const content of [CONTINUE_AFTER_ERROR_PROMPT, { text: CONTINUE_AFTER_ERROR_PROMPT }]) {
      expect(isContinuationMessage({ role: 'user', content })).toBe(true);
      expect(isContinuationMessage({ role: 'assistant', content })).toBe(false);
    }
    expect(isContinuationMessage({ role: 'user', content: '', isContinuationTrigger: true })).toBe(true);
    expect(isContinuationMessage({ role: 'user', agentMeta: { autoResume: true } })).toBe(true);
    expect(isContinuationMessage({ role: 'user', systemCardType: 'auto-resume' })).toBe(true);
    expect(isContinuationMessage({ role: 'user', content: `${UI_ACTION_TRIGGER_PREFIX} regenerate` })).toBe(false);
    expect(isContinuationMessage({ role: 'user', content: null })).toBe(false);
  });

  it.each([CONTINUE_AFTER_ERROR_PROMPT, CONTINUE_AFTER_APP_EXIT_PROMPT,
    `${CONTINUE_AFTER_ERROR_PROMPT}\n\n[CINDY_RECOVERY_CHECKPOINT v1]\nattempt 2`,
  ])('recognizes the same continuation across persisted content representations', (text) => {
    const envelope = { text, images: [], files: [] };
    for (const content of [text, envelope, JSON.stringify(envelope), ` \n${JSON.stringify(envelope)}`]) {
      expect(isContinuationMessage({ role: 'user', content })).toBe(true);
      expect(isContinuationMessage({ role: 'assistant', content })).toBe(false);
    }
  });

  it.each([null, '{broken', '{}', '{"text":42}', '{"text":null}', '[]',
    JSON.stringify({ text: `${UI_ACTION_TRIGGER_PREFIX} regenerate` }),
    JSON.stringify({ text: `Quoting ${CONTINUE_AFTER_ERROR_PROMPT}` }),
    JSON.stringify({ content: CONTINUE_AFTER_ERROR_PROMPT }),
    JSON.stringify([{ text: CONTINUE_AFTER_ERROR_PROMPT }]),
  ])('does not treat unrelated or malformed envelopes as recovery: %j', (content) => {
    expect(isContinuationMessage({ role: 'user', content })).toBe(false);
  });

  it('detects the magic prefix on raw text', () => {
    expect(isSyntheticTriggerText(`${UI_ACTION_TRIGGER_PREFIX} do something`)).toBe(true);
    expect(isSyntheticTriggerText('normal user message')).toBe(false);
    // 前缀必须在开头,正文中间出现不算(用户完全可能在消息里聊到这个字符串)
    expect(isSyntheticTriggerText(`quoting ${UI_ACTION_TRIGGER_PREFIX} mid-text`)).toBe(false);
  });

  it('classifies continuation prompts vs generic triggers', () => {
    expect(syntheticTriggerKind(CONTINUE_AFTER_APP_EXIT_PROMPT)).toBe('continue');
    expect(syntheticTriggerKind(CONTINUE_AFTER_ERROR_PROMPT)).toBe('continue');
    expect(
      syntheticTriggerKind(
        `${CONTINUE_AFTER_ERROR_PROMPT}\n\n[CINDY_RECOVERY_CHECKPOINT v1]\nattempt 2`,
      ),
    ).toBe('continue');
    expect(syntheticTriggerKind(`${UI_ACTION_TRIGGER_PREFIX} regenerate the mivo image`)).toBe('generic');
    expect(syntheticTriggerKind('normal user message')).toBeNull();
  });

  it('keeps both continuation prompts prefixed so every consumer-side filter keeps working', () => {
    // 续跑 prompt 若丢失前缀,桌面/手机所有「面向用户的文本消费」过滤会同时失效
    expect(isSyntheticTriggerText(CONTINUE_AFTER_APP_EXIT_PROMPT)).toBe(true);
    expect(isSyntheticTriggerText(CONTINUE_AFTER_ERROR_PROMPT)).toBe(true);
  });
});
