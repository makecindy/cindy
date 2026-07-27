import { describe, expect, it } from 'vitest';

import { canResumePendingConsent, makeConsentStamp } from '../consentGate';

/**
 * consentGate 行为单测(codex 审查 P1:pending 陈旧续接竞态)。
 * 手机镜像见 apps/mobile/src/auth/__tests__/consentGate.test.ts,
 * 用例集必须保持一致(双端语义同源)。
 */
describe('consentGate:pending 续接校验', () => {
  const opened = makeConsentStamp('identifier', false, false);

  it('上下文未漂移 → 允许续接', () => {
    expect(canResumePendingConsent(opened, makeConsentStamp('identifier', false, false))).toBe(
      true,
    );
  });

  it('弹窗期间登录已完成(authenticated)→ 丢弃动作', () => {
    expect(canResumePendingConsent(opened, makeConsentStamp('identifier', false, true))).toBe(
      false,
    );
  });

  it('弹窗期间另一路登录 in-flight(busy)→ 丢弃动作', () => {
    expect(canResumePendingConsent(opened, makeConsentStamp('identifier', true, false))).toBe(
      false,
    );
  });

  it('弹窗期间步骤切换(深链回调推进流程)→ 丢弃动作', () => {
    expect(
      canResumePendingConsent(opened, makeConsentStamp('verification-code', false, false)),
    ).toBe(false);
    expect(canResumePendingConsent(opened, makeConsentStamp('completed', false, false))).toBe(
      false,
    );
  });

  it('step undefined 归一为 unknown:开门与复验同为 undefined 时视为未漂移', () => {
    const openedUnknown = makeConsentStamp(undefined, false, false);
    expect(openedUnknown.step).toBe('unknown');
    expect(canResumePendingConsent(openedUnknown, makeConsentStamp(undefined, false, false))).toBe(
      true,
    );
    expect(
      canResumePendingConsent(openedUnknown, makeConsentStamp('identifier', false, false)),
    ).toBe(false);
  });
});
