import { describe, expect, it } from 'vitest';

import { resolveDisplayContextWindow } from '@/lib/contextWindow';
import { makerChatStore } from '@/lib/makerChatStore';

describe('resolveDisplayContextWindow', () => {
  it('prefers maker capability when SDK reports the unknown-model 200K default', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 992_000,
      sdkContextWindow: 200_000,
    })).toBe(992_000);
  });

  it('does not let a stale 200K value from the previous model hide DeepSeek 1M context', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 1_048_576,
      sdkContextWindow: 200_000,
    })).toBe(1_048_576);
  });

  // app-server 报的是**基础模型**窗口, 忽略网关对该路由的实际限制。目录值是产品侧
  // 维护的真实上限, 不能被这种虚高值盖掉 —— 否则圆环把 372K 会话显示成 1M,
  // 用户在真实上限前就被压缩, 却以为还剩 60% 余量。
  it('caps the SDK value at the catalog window for gateway-routed models', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 372_000,
      sdkContextWindow: 1_000_000,
    })).toBe(372_000);
  });

  it('caps to the catalog window even when the gap is small', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 992_000,
      sdkContextWindow: 1_000_000,
    })).toBe(992_000);
  });

  it('keeps a smaller SDK value when the route is actually downsized', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 1_000_000,
      sdkContextWindow: 400_000,
    })).toBe(400_000);
  });

  it('trusts the SDK value when the catalog has no entry for the model', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: undefined,
      sdkContextWindow: 1_000_000,
    })).toBe(1_000_000);
  });

  it('falls back to the model capability before the hardcoded default', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 262_144,
      sdkContextWindow: 0,
    })).toBe(262_144);
  });

  it('falls back to the hardcoded default when neither source is known', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: undefined,
      sdkContextWindow: 0,
    })).toBe(200_000);
  });
});

describe('makerChatStore context window refresh', () => {
  it('updates the displayed context window without waiting for the next turn', () => {
    const sessionId = 'context-window-switch-test';
    makerChatStore.purgeSession(sessionId);

    makerChatStore.setContextWindow(sessionId, 1_048_576);

    expect(makerChatStore.getSnapshot(sessionId).agentStatus.contextWindow).toBe(1_048_576);
    makerChatStore.purgeSession(sessionId);
  });
});
