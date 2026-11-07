import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  applyUltra: vi.fn<(body: unknown, providerId: string | null | undefined) => unknown | null>(),
  restrictFast:
    vi.fn<
      (
        body: unknown,
        sessionId: string | null | undefined,
        providerId: string | null | undefined,
      ) => unknown | null
    >(),
}));

vi.mock('../subscription-ultra-policy.js', () => ({
  applySubscriptionUltraPolicy: state.applyUltra,
}));
vi.mock('../subscription-fast-request-policy.js', () => ({
  restrictSubscriptionRequest: state.restrictFast,
}));

import { applyCodexWebSocketSubscriptionPolicies } from '../codex-websocket-request-policy.js';

afterEach(() => {
  state.applyUltra.mockReset();
  state.restrictFast.mockReset();
});

describe('WebSocket subscription policies', () => {
  it('keeps the Ultra rewrite when Fast allows the frame unchanged', () => {
    const original = { model: 'gpt-6.1-sol', reasoning: { effort: 'ultra' } };
    const downgraded = { model: 'gpt-6.1-sol', reasoning: { effort: 'max' } };
    state.applyUltra.mockReturnValue(downgraded);
    state.restrictFast.mockReturnValue(null);

    expect(applyCodexWebSocketSubscriptionPolicies(original, 'openai', 'session-1')).toBe(
      downgraded,
    );
    expect(state.restrictFast).toHaveBeenCalledWith(downgraded, 'session-1', 'openai');
  });

  it('uses the Fast-restricted frame when both policies rewrite it', () => {
    const downgraded = { reasoning: { effort: 'max' } };
    const standard = { reasoning: { effort: 'max' }, service_tier: 'default' };
    state.applyUltra.mockReturnValue(downgraded);
    state.restrictFast.mockReturnValue(standard);

    expect(applyCodexWebSocketSubscriptionPolicies({}, 'openai', 'session-1')).toBe(standard);
  });

  it('leaves the original frame alone when neither policy changes it', () => {
    state.applyUltra.mockReturnValue(null);
    state.restrictFast.mockReturnValue(null);

    expect(applyCodexWebSocketSubscriptionPolicies({}, 'xd', null)).toBeNull();
    expect(state.restrictFast).toHaveBeenCalledWith({}, null, 'xd');
  });
});
