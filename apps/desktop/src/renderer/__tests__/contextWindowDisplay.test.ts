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

  it('replaces a restored large window only with verified route metadata', () => {
    expect(resolveDisplayContextWindow({
      sdkContextWindow: 1_050_000,
      modelContextWindow: 272_000,
      verifiedContextWindow: 272_000,
    })).toBe(272_000);
    expect(resolveDisplayContextWindow({
      sdkContextWindow: 1_050_000,
      modelContextWindow: 272_000,
    })).toBe(1_050_000);
  });

  it('follows an explicit long window and ignores invalid verified values', () => {
    expect(resolveDisplayContextWindow({
      sdkContextWindow: 272_000,
      verifiedContextWindow: 872_000,
    })).toBe(872_000);
    for (const verifiedContextWindow of [null, 0, -1, NaN, Infinity]) {
      expect(resolveDisplayContextWindow({ sdkContextWindow: 872_000, verifiedContextWindow }))
        .toBe(872_000);
    }
  });
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
  it('preserves Codex usage when a model selection supplies another catalog window', () => {
    const sessionId = 'codex-context-window-switch-test';
    makerChatStore.purgeSession(sessionId);
    makerChatStore.setContextWindow(sessionId, 258_400);
    makerChatStore.setSessionRuntime(sessionId, { agentKind: 'codex' });

    makerChatStore.setContextWindow(sessionId, 1_050_000);
    expect(makerChatStore.getSnapshot(sessionId).agentStatus.contextWindow).toBe(258_400);
    makerChatStore.purgeSession(sessionId);
  });

  it('updates the displayed context window without waiting for the next turn', () => {
    const sessionId = 'context-window-switch-test';
    makerChatStore.purgeSession(sessionId);

    makerChatStore.setContextWindow(sessionId, 1_048_576);

    expect(makerChatStore.getSnapshot(sessionId).agentStatus.contextWindow).toBe(1_048_576);
    makerChatStore.purgeSession(sessionId);
  });
});
