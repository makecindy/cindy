import { afterEach, describe, expect, it } from 'vitest';
import { antigravityProvider, setAntigravityState } from '../antigravity-state';

afterEach(() => setAntigravityState(null));
describe('native Google subscription metadata', () => {
  it('preserves model-specific tiers and fixed effort instead of flattening everything to unsupported', () => {
    setAntigravityState({ connected: true, tier: { id: 'g1-pro-tier', name: 'Google AI Pro' }, models: [
      { id: 'gemini-4-hydrogen', name: 'Hydrogen', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', effortDisplayNames: { xhigh: 'Extra' } },
      { id: 'gemini-pro-orchestrator-g1-pro', name: 'Orchestrator', efforts: [], defaultEffort: null },
    ] });
    const provider = antigravityProvider()!;
    expect(provider.models.antigravity?.[0]).toMatchObject({ efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'high', effortDisplayNames: { xhigh: 'Extra' }, supportsFastMode: false });
    expect(provider.models.antigravity?.[1]).toMatchObject({ efforts: [], defaultEffort: null });
    expect(provider.access?.kind).toBe('subscription'); expect(provider.routing.antigravity?.transport).toBe('acp');
  });
  it('does not publish another owner or an unconfigured engine into the existing catalog', () => {
    expect(antigravityProvider()).toBeNull();
    setAntigravityState({ connected: true, isCurrent: () => false, models: [] });
    expect(antigravityProvider()).toBeNull();
  });
  it('keeps Claude and GPT-OSS on the Google OAuth provider with native effort metadata', () => {
    setAntigravityState({ connected: true, tier: { id: 'g1-pro-tier', name: 'Google AI Pro' }, models: [
      { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)', efforts: [], defaultEffort: null },
    ] });
    const provider = antigravityProvider()!;
    expect(provider).toMatchObject({ id: 'google-antigravity-subscription', agents: ['antigravity'], auth: { method: 'oauth' }, access: { kind: 'subscription' } });
    expect(provider.models.antigravity?.map(model => [model.id, model.efforts, model.defaultEffort])).toEqual([
      ['claude-opus-5-5', ['low', 'medium', 'high'], 'medium'], ['claude-sonnet-5-5', ['low', 'medium', 'high'], 'medium'], ['gpt-oss-120b-medium', [], null],
    ]);
  });
});
