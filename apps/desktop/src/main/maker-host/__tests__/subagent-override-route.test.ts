import { describe, expect, it } from 'vitest';

import { shouldKeepSubagentOverrideForParent } from '../subagent-override-route.js';

function decide(
  saved: string,
  providerId: string | null,
  extra: Partial<Parameters<typeof shouldKeepSubagentOverrideForParent>[0]> = {},
) {
  return shouldKeepSubagentOverrideForParent({
    saved,
    providerId,
    parentOffersSaved: false,
    parentCopyDisabled: false,
    anyOffering: true,
    allOfferingsDisabled: false,
    ...extra,
  });
}

describe('shouldKeepSubagentOverrideForParent', () => {
  it('父来源自己提供该模型时按停用轴决定', () => {
    expect(decide('claude-opus-5', 'anthropic', { parentOffersSaved: true })).toBe(true);
    expect(decide('claude-opus-5', 'anthropic', {
      parentOffersSaved: true,
      parentCopyDisabled: true,
    })).toBe(false);
  });

  it('xai/ 与 chatgpt/ 覆写在显式非供应父来源下仍注入(旧半修会丢掉)', () => {
    expect(decide('xai/grok-4.6', 'xd')).toBe(true);
    expect(decide('xai/grok-4.6', 'anthropic')).toBe(true);
    expect(decide('xai/grok-4.6', 'gemini')).toBe(true);
    expect(decide('chatgpt/gpt-5.5', 'xd')).toBe(true);
  });

  it('裸 grok 不能跟着非 xAI 父会话注入', () => {
    expect(decide('grok-4.6', 'xd')).toBe(false);
    expect(decide('grok-4.6', 'anthropic')).toBe(false);
    expect(decide('grok-4.6', 'gemini')).toBe(false);
    expect(decide('grok-4.6', 'xai', { anyOffering: false })).toBe(true);
  });

  it('普通模型在显式父来源不提供时不注入', () => {
    expect(decide('claude-opus-5', 'gemini')).toBe(false);
  });
});
