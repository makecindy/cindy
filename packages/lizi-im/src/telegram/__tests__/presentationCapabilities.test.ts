import { describe, expect, it } from 'vitest';

import { TELEGRAM_PERSONAL_CAPABILITIES } from '../presentationCapabilities.js';

/**
 * 呈现能力契约的单一真相源锚定(#1855 L1)。可兑现字段的**实际消费**由 index.ts
 * 编译期强制(typing 续命间隔/上限、link preview 直接引用本常量,若改名/删除则 tsc
 * 失败);本文件锚定契约值本身,防止有人把值改回第二真相源。
 */
describe('TELEGRAM_PERSONAL_CAPABILITIES — 个人车道能力契约(单一出处)', () => {
  it('声明个人车道现值(driver 直接消费的可兑现字段 + 声明车道差异)', () => {
    expect(TELEGRAM_PERSONAL_CAPABILITIES).toEqual({
      progressSilent: true,
      typingKeepaliveMs: 4_500,
      typingKeepaliveMaxMs: 5 * 60_000,
      linkPreviewDisabled: true,
      noReplyScope: 'all-turns',
      messageEffectIdSupported: false,
      threadIdDualSemantics: true,
      laneModel: 'per-chat',
    });
  });

  it('typing 续命 4.5s < 上限 5min(续命间隔远小于兜底上限)', () => {
    expect(TELEGRAM_PERSONAL_CAPABILITIES.typingKeepaliveMs).toBeLessThan(
      TELEGRAM_PERSONAL_CAPABILITIES.typingKeepaliveMaxMs,
    );
  });

  it('NO_REPLY 生效范围为 all-turns(与 streamingText.finalize 的无 ambient 门控一致)', () => {
    expect(TELEGRAM_PERSONAL_CAPABILITIES.noReplyScope).toBe('all-turns');
  });
});
