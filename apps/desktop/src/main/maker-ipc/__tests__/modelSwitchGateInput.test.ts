import { describe, expect, it } from 'vitest';
import {
  describeModelWindowGateFailure,
  resolveModelSwitchContextTokens,
  resolveModelSwitchWindows,
} from '../modelSwitchGateInput';

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

  // A remote owner selection that would rebuild native context is refused unless every window is
  // verified. The refusal names the first failing check so the user can tell an unset model window
  // from a Pi that merely cannot hot-switch.
  describe('model window gate refusal', () => {
    // Regression: a remote owner's Claude switch after quota exhaustion must not
    // be rejected merely because the old provider lacks window metadata (unit).
    it.each([
      { verifiedCurrentWindow: undefined },
      { targetContextWindow: undefined },
      { contextTokensKnown: false },
    ])('allows Claude to try the selected route with incomplete metadata: %j', missing => {
      expect(describeModelWindowGateFailure({
        contextTokensKnown: true, verifiedCurrentWindow: 200_000, targetContextWindow: 128_000,
        runtimeAgentKind: 'claude-code', model: 'next', targetRouteProviderId: 'provider',
        rebuildLiveOrcaWorker: false, piPreview: undefined, ...missing,
      })).toBeNull();
    });
    const base = {
      contextTokensKnown: true, verifiedCurrentWindow: 250_000, targetContextWindow: 1_000_000,
      runtimeAgentKind: 'pi', model: 'deepseek-v4.1-flash', targetRouteProviderId: 'opencode-go',
      rebuildLiveOrcaWorker: false, piPreview: { action: 'refresh' },
    };

    it('passes a hot switch or a refresh with every window verified', () => {
      expect(describeModelWindowGateFailure({ ...base, piPreview: { action: 'hot' } })).toBeNull();
      expect(describeModelWindowGateFailure(base)).toBeNull();
      expect(describeModelWindowGateFailure({ ...base, runtimeAgentKind: 'claude-code', piPreview: undefined })).toBeNull();
    });

    it('names an unverified target model by route, in the gate\'s check order', () => {
      expect(describeModelWindowGateFailure({ ...base, targetContextWindow: undefined, piPreview: undefined }))
        .toEqual({ category: 'target-window-unverified', detail: 'target model opencode-go/deepseek-v4.1-flash has no verified context window' });
      expect(describeModelWindowGateFailure({ ...base, targetRouteProviderId: null, targetContextWindow: undefined })?.detail)
        .toBe('target model deepseek-v4.1-flash has no verified context window');
      expect(describeModelWindowGateFailure({ ...base, contextTokensKnown: false, verifiedCurrentWindow: undefined })?.category)
        .toBe('context-usage-unknown');
      expect(describeModelWindowGateFailure({ ...base, verifiedCurrentWindow: undefined })?.category)
        .toBe('current-window-unverified');
    });

    it('carries Pi\'s preview reason and tells a missing preview apart', () => {
      expect(describeModelWindowGateFailure({ ...base, piPreview: { action: 'rebuild' } }))
        .toEqual({ category: 'pi-preview-rebuild', detail: 'Pi cannot switch to opencode-go/deepseek-v4.1-flash' });
      expect(describeModelWindowGateFailure({ ...base, piPreview: { action: 'unavailable', reason: 'Pi provider \'x\' is not available in the current catalog' } }))
        .toEqual({ category: 'pi-preview-unavailable', detail: 'Pi provider \'x\' is not available in the current catalog' });
      expect(describeModelWindowGateFailure({ ...base, piPreview: undefined })?.category).toBe('pi-preview-missing');
      expect(describeModelWindowGateFailure({ ...base, rebuildLiveOrcaWorker: true })?.category).toBe('orca-worker-rebuild');
    });
  });
});
