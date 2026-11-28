import { describe, expect, it } from 'vitest';

import { resolveDisplayContextWindow } from '@/lib/contextWindow';
import { makerChatStore } from '@/lib/makerChatStore';

describe('resolveDisplayContextWindow', () => {
  it('does not combine previous usage with a window pending CLI restart', () => {
    const input = { sdkContextWindow: 258_400, nativeContextWindow: 1_000_000,
      runtimeWindowAuthoritative: true, modelContextWindow: 1_050_000 };
    expect(resolveDisplayContextWindow({ ...input, nativeContextPending: true })).toBe(0);
    expect(resolveDisplayContextWindow({ ...input, nativeContextPending: false })).toBe(1_000_000);
  });
  it.each([100_000, 128_000, 200_000, 272_000, 872_000])(
    'shows native Codex total %s regardless of model specs or usable-window snapshot',
    (nativeContextWindow) => {
      for (const verifiedContextWindow of [272_000, 1_050_000]) {
        expect(resolveDisplayContextWindow({
          sdkContextWindow: Math.floor(nativeContextWindow * 0.95),
          nativeContextWindow,
          runtimeWindowAuthoritative: true,
          modelContextWindow: 1_050_000,
          verifiedContextWindow,
        })).toBe(nativeContextWindow);
      }
    },
  );

  it('shows unknown until native Codex total is read, even with catalog metadata', () => {
    expect(resolveDisplayContextWindow({
      sdkContextWindow: 258_400,
      runtimeWindowAuthoritative: true,
      verifiedContextWindow: 1_050_000,
    })).toBe(0);
  });

  it.each([1_000, 32_000, 100_000, 128_000, 200_000, 872_000])(
    'preserves applied Claude/Pi budget %s even when catalog values disagree',
    (sdkContextWindow) => {
      expect(resolveDisplayContextWindow({
        sdkContextWindow, verifiedContextWindow: 1_050_000, modelContextWindow: 1_050_000,
      })).toBe(sdkContextWindow);
    },
  );

  it('uses verified route metadata only before runtime usage is available', () => {
    expect(resolveDisplayContextWindow({
      sdkContextWindow: 0, modelContextWindow: 1_050_000, verifiedContextWindow: 272_000,
    })).toBe(272_000);
    for (const verifiedContextWindow of [null, 0, -1, NaN, Infinity]) {
      expect(resolveDisplayContextWindow({ sdkContextWindow: 872_000, verifiedContextWindow }))
        .toBe(872_000);
    }
  });
  it('keeps non-default SDK values as runtime ground truth', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 992_000,
      sdkContextWindow: 1_000_000,
    })).toBe(1_000_000);
  });

  it('falls back to the model capability before the hardcoded default', () => {
    expect(resolveDisplayContextWindow({
      modelContextWindow: 262_144,
      sdkContextWindow: 0,
    })).toBe(262_144);
  });
});

describe('makerChatStore context window refresh', () => {
  it.each(['pi', 'claude-code'] as const)('refreshes %s metadata on consecutive model choices before any runtime usage', (agentKind) => {
    const sessionId = `${agentKind}-context-window-switch-test`;
    makerChatStore.purgeSession(sessionId);
    makerChatStore.setSessionRuntime(sessionId, { agentKind });
    for (const window of [1_000, 32_000, 1_050_000, 1_000]) {
      makerChatStore.setContextWindow(sessionId, window);
      expect(makerChatStore.getSnapshot(sessionId).agentStatus.contextWindow).toBe(window);
    }
    makerChatStore.purgeSession(sessionId);
  });

  it.each([0, 9_000])('preserves an actual runtime budget with %s tokens against later metadata', (contextTokens) => {
    const sessionId = 'runtime-budget-test';
    makerChatStore.purgeSession(sessionId);
    makerChatStore.setContextWindow(sessionId, 32_000);
    makerChatStore.__applyStatusUpdateForTest(sessionId, {
      sessionId, status: 'Done', isRunning: false, tokenUsage: 0, costUsd: 0,
      contextTokens, contextWindow: 1_000,
    });
    makerChatStore.setContextWindow(sessionId, 1_050_000);
    expect(makerChatStore.getSnapshot(sessionId).agentStatus.contextWindow).toBe(1_000);
    makerChatStore.purgeSession(sessionId);
  });

  it('keeps Codex metadata unknown before a native snapshot arrives', () => {
    const sessionId = 'codex-metadata-test';
    makerChatStore.purgeSession(sessionId);
    makerChatStore.setSessionRuntime(sessionId, { agentKind: 'codex' });
    makerChatStore.setContextWindow(sessionId, 1_000);
    makerChatStore.setContextWindow(sessionId, 32_000);
    expect(makerChatStore.getSnapshot(sessionId).agentStatus.contextWindow).toBe(0);
    makerChatStore.purgeSession(sessionId);
  });

  it('updates the displayed context window without waiting for the next turn', () => {
    const sessionId = 'context-window-switch-test';
    makerChatStore.purgeSession(sessionId);

    makerChatStore.setContextWindow(sessionId, 1_048_576);

    expect(makerChatStore.getSnapshot(sessionId).agentStatus.contextWindow).toBe(1_048_576);
    makerChatStore.purgeSession(sessionId);
  });

  // 伙伴聊天只用圆环显示上下文占用: Pi 在请求开始时会报「窗口 + 0 token」,
  // 此时窗口虽已来自运行期, 用量还不能算已知, 否则圆环会提前显示 0%。
  it('does not treat a startup zero-token report as known usage', () => {
    const sessionId = 'context-usage-startup';
    makerChatStore.purgeSession(sessionId);
    makerChatStore.__applyStatusUpdateForTest(sessionId, {
      sessionId, status: 'Working', isRunning: true, tokenUsage: 0, costUsd: 0,
      contextTokens: 0, contextWindow: 1_000_000,
    });
    const status = makerChatStore.getSnapshot(sessionId).agentStatus;
    expect(status.contextWindowFromRuntime).toBe(true);
    expect(status.contextUsageReported).not.toBe(true);
    makerChatStore.purgeSession(sessionId);
  });

  it.each<[string, Partial<CCAgentStatusUpdate>]>([
    ['a completed turn', { status: 'Done', isRunning: false, contextTokens: 0 }],
    ['a mid-turn non-zero report', { status: 'Working', isRunning: true, contextTokens: 12_340 }],
    ['an authoritative mid-turn snapshot', {
      status: 'Working', isRunning: true, contextTokens: 0, contextSnapshotAuthoritative: true,
    }],
  ])('marks usage known after %s', (_label, update) => {
    const sessionId = 'context-usage-known';
    makerChatStore.purgeSession(sessionId);
    makerChatStore.__applyStatusUpdateForTest(sessionId, {
      sessionId, tokenUsage: 0, costUsd: 0, contextWindow: 1_000_000, ...update,
    });
    expect(makerChatStore.getSnapshot(sessionId).agentStatus.contextUsageReported).toBe(true);
    makerChatStore.purgeSession(sessionId);
  });
});
