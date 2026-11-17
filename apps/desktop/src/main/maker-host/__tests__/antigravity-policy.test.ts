import { describe, expect, it } from 'vitest';
import { antigravitySubscriptionArgs, assertAntigravitySubscriptionSettings as check, assertAntigravityGenerationAllowed as allowGeneration } from '../antigravity-policy.js';
describe('pinned Antigravity subscription spending policy', () => {
  it('accepts the official CLI normalizing default-valued keys away', () => {
    expect(() => check({ toolPermission: 'strict' })).not.toThrow();
    expect(() => check({ toolPermission: 'strict', useG1Credits: false, modelProvider: '', agentMode: '' })).not.toThrow();
  });
  it('rejects credits, API providers, ADC and weakened permissions in either settings source', () => {
    for (const override of [{ useG1Credits: true }, { useG1Credits: 'false' }, { modelProvider: 'gemini-api-key' }, { enableAdc: true }, { agentMode: 'auto' }, { toolPermission: 'auto' }, { gcp: {} }]) {
      expect(() => check({ toolPermission: 'strict', ...override })).toThrow();
      expect(() => check({ toolPermission: 'strict' }, override)).toThrow();
    }
    expect(() => check({})).toThrow();
  });
});

// Production preflight: the quota-only, paused integration must never dispatch a
// turn, including when an earlier configuration claimed a verified boundary.
// Existing policy tests did not cover that bypass. Unit; no process or account.
describe('Antigravity paused generation', () => {
  it('blocks generation regardless of legacy verification or credit-consent flags', () => {
    for (const config of [{}, { subscriptionBoundaryVerified: true }, { billingMode: 'existing-credits', existingCreditsConsent: true }, { billingMode: 'quota-only', generationPaused: false }]) {
      expect(() => allowGeneration(config)).toThrow('生成已暂停');
    }
  });
  it('reports disconnection before an attempted turn', () => {
    expect(() => allowGeneration({ authDisconnected: true })).toThrow('已断开');
  });
  it('requires the explicit subscription-only mode and rejects disconnects', () => {
    expect(() => allowGeneration({ generationMode: 'subscription-only' })).not.toThrow();
    expect(() => allowGeneration({ generationMode: 'subscription-only', authDisconnected: true })).toThrow('已断开');
  });
  it('applies the explicit credits-off override to the ACP process itself', () => {
    const args = antigravitySubscriptionArgs('/isolated/.gemini');
    expect(args[0]).toBe('--settings');
    expect(JSON.parse(args[1])).toMatchObject({ useG1Credits: false, modelProvider: '', toolPermission: 'strict' });
    expect(args[2]).toBe('acp');
    expect(args).not.toContain('--process-per-session');
  });
  it.each([
    ['ask', 'strict', false], ['auto', 'request-review', false],
    ['acceptEdits', 'request-review', false], ['bypassPermissions', 'always-proceed', true],
  ])('maps %s to the native policy without changing the spending route', (mode, toolPermission, full) => {
    const settings = JSON.parse(antigravitySubscriptionArgs('/isolated/.gemini', mode)[1]);
    expect(settings).toMatchObject({ useG1Credits: false, modelProvider: '', toolPermission });
    expect(settings.allowNonWorkspaceAccess === true).toBe(full);
  });
  it('uses the official HTTP MCP worker mode and native full-access flag only when requested', () => {
    expect(antigravitySubscriptionArgs('/isolated/.gemini', 'auto', true)).toContain('--process-per-session');
    expect(antigravitySubscriptionArgs('/isolated/.gemini', 'auto', true)).not.toContain('--dangerously-skip-permissions');
    expect(antigravitySubscriptionArgs('/isolated/.gemini', 'bypassPermissions', true)).toContain('--dangerously-skip-permissions');
  });
});
