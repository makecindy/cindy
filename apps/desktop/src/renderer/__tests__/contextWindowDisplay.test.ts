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
  it('updates the displayed context window without waiting for the next turn', () => {
    const sessionId = 'context-window-switch-test';
    makerChatStore.purgeSession(sessionId);

    makerChatStore.setContextWindow(sessionId, 1_048_576);

    expect(makerChatStore.getSnapshot(sessionId).agentStatus.contextWindow).toBe(1_048_576);
    makerChatStore.purgeSession(sessionId);
  });
});
