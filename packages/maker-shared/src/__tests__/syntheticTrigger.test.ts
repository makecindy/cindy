import { describe, expect, it } from 'vitest';
import {
  CONTINUE_AFTER_APP_EXIT_PROMPT,
  CONTINUE_AFTER_ERROR_PROMPT,
  UI_ACTION_TRIGGER_PREFIX,
  isSyntheticTriggerText,
  syntheticTriggerKind,
} from '../syntheticTrigger.js';

describe('synthetic trigger detection', () => {
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
