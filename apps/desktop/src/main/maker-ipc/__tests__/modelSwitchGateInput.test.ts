import { describe, expect, it } from 'vitest';
import { resolveModelSwitchContextTokens, resolveModelSwitchWindows } from '../modelSwitchGateInput';

// The window gate's input the desktop's model change and the Node Host's share. A shrink is judged
// only on verified windows (Pi's current window only from its runtime), and the running runtime's
// usage counts only when it is authoritative; otherwise the task row's reading stands.
describe('model switch gate input', () => {
  const windows: Record<string, number> = { 'big/model': 200_000, 'small/model': 32_000 };
  const resolveRouteWindow = (_kind: string, modelId: string, pid: string | null) =>
    pid === 'provider' ? windows[modelId] ?? null : null;
  const base = {
    resolveRouteWindow, model: 'small/model', targetRouteProviderId: 'provider',
    currentRuntimeModel: 'big/model', currentProviderId: 'provider', piPreview: undefined, liveCurrentWindow: undefined,
  };

  it('verifies both windows from the catalog for Claude and Codex, ignoring a live window', () => {
    expect(resolveModelSwitchWindows({ ...base, runtimeAgentKind: 'claude-code', liveCurrentWindow: 1_000_000 }))
      .toEqual({ verifiedTargetWindow: 32_000, verifiedCurrentWindow: 200_000 });
  });

  it('takes Pi\'s current window only from its runtime and caps a verified preview by the catalog', () => {
    expect(resolveModelSwitchWindows({ ...base, runtimeAgentKind: 'pi', liveCurrentWindow: 128_000,
      piPreview: { windowVerified: true, targetContextWindow: 64_000 } }))
      .toEqual({ verifiedTargetWindow: 32_000, verifiedCurrentWindow: 128_000 });
    expect(resolveModelSwitchWindows({ ...base, runtimeAgentKind: 'pi', targetRouteProviderId: 'other',
      piPreview: { windowVerified: true, targetContextWindow: 64_000 } }))
      .toEqual({ verifiedTargetWindow: 64_000, verifiedCurrentWindow: undefined });
  });

  it('resolves the current window on the task\'s own source provider', () => {
    expect(resolveModelSwitchWindows({ ...base, runtimeAgentKind: 'codex' }).verifiedCurrentWindow).toBe(200_000);
    expect(resolveModelSwitchWindows({ ...base, runtimeAgentKind: 'codex', currentProviderId: 'other' }).verifiedCurrentWindow)
      .toBeUndefined();
  });

  it('does not take a persisted reading that is not a valid count', () => {
    for (const contextTokens of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(resolveModelSwitchContextTokens({ contextTokens }, undefined)).toEqual({ contextTokensKnown: false, contextTokens: 0 });
    }
    expect(resolveModelSwitchContextTokens({ contextTokens: -1 }, Number.NaN)).toEqual({ contextTokensKnown: false, contextTokens: 0 });
  });

  it('counts live usage only when authoritative, otherwise the persisted reading', () => {
    expect(resolveModelSwitchContextTokens({ contextTokens: 10 }, 90_000)).toEqual({ contextTokensKnown: true, contextTokens: 90_000 });
    expect(resolveModelSwitchContextTokens({ contextTokens: 120_000 }, 0)).toEqual({ contextTokensKnown: true, contextTokens: 120_000 });
    expect(resolveModelSwitchContextTokens({ contextTokens: 0 }, 0)).toEqual({ contextTokensKnown: true, contextTokens: 0 });
    expect(resolveModelSwitchContextTokens({ contextTokens: null }, undefined)).toEqual({ contextTokensKnown: false, contextTokens: 0 });
  });
});
