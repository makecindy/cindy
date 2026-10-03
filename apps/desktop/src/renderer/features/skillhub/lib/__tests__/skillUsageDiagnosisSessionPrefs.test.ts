import { describe, expect, it, vi } from 'vitest';
import type { AgentKind, CatalogModel, ProviderView } from '@cindy/model-providers';
import type { AgentCapabilities } from '@/hooks/useAgentCapabilities';
import type { VendorPrefs } from '@/state/newMakerDraft';
import { resolveSkillUsageDiagnosisSessionPrefs, selectDiagnosisAgent } from '../skillUsageDiagnosisSessionPrefs';

const capabilities = { hasFastMode: true } as AgentCapabilities;
const prefs: VendorPrefs = { model: 'selected', providerId: 'byom', effort: 'high', permissionMode: 'ask', planMode: true };
function provider(agent: AgentKind, overrides: Partial<CatalogModel> = {}): ProviderView {
  return {
    id: 'byom', source: 'user', connected: true, agents: [agent],
    routing: { [agent]: { upstream: 'https://example.test', authStrategy: 'none' } },
    models: { [agent]: [{ id: 'selected', name: 'Selected', group: 'test', status: 'active',
      contextWindow: 100_000, efforts: ['low', 'high'], defaultEffort: 'low', supportsFastMode: true, ...overrides }] },
  } as unknown as ProviderView;
}

describe('diagnosis local task preferences', () => {
  it.each(['cc', 'codex', 'pi'] as const)('retains complete %s preferences and reads the actual agent/provider/model preset', (agentKind) => {
    const agent: AgentKind = agentKind === 'cc' ? 'claude-code' : agentKind;
    const effortForModel = vi.fn(() => 'low');
    const fastForModel = vi.fn(() => false);
    const legacyFastForModel = vi.fn(() => true);
    const result = resolveSkillUsageDiagnosisSessionPrefs({
      agentKind, prefs, modelChosenByUser: true, providers: [provider(agent)], providersLoading: false,
      capabilities, effortForModel, fastForModel, legacyFastForModel,
    });
    expect(result).toEqual({ agentKind, model: 'selected', providerId: 'byom', effort: 'low',
      permissionMode: 'ask', planModeEnabled: true, fastMode: false });
    expect(effortForModel).toHaveBeenCalledWith(agent, 'byom', 'selected');
    expect(fastForModel).toHaveBeenCalledWith(agent, 'byom', 'selected');
    expect(legacyFastForModel).not.toHaveBeenCalled();
    expect(prefs).toEqual({ model: 'selected', providerId: 'byom', effort: 'high', permissionMode: 'ask', planMode: true });
  });

  it('calibrates an unchosen model before resolving source, effort and Fast', () => {
    const effortForModel = vi.fn(() => 'invalid');
    const fastForModel = vi.fn(() => undefined);
    const legacyFastForModel = vi.fn(() => true);
    const result = resolveSkillUsageDiagnosisSessionPrefs({
      agentKind: 'pi', prefs: { ...prefs, model: 'old-seed', providerId: null }, modelChosenByUser: false,
      providers: [provider('pi', { id: 'new-default', efforts: ['low'], defaultEffort: 'low' })],
      providersLoading: false, capabilities, effortForModel, fastForModel, legacyFastForModel,
    });
    expect(result).toMatchObject({ model: 'new-default', providerId: 'byom', effort: 'low', fastMode: true });
    expect(effortForModel).toHaveBeenCalledWith('pi', 'byom', 'new-default');
    expect(fastForModel).toHaveBeenCalledWith('pi', 'byom', 'new-default');
    expect(legacyFastForModel).toHaveBeenCalledWith('new-default');
  });

  it('retains an explicit disconnected source instead of silently using another account', () => {
    const result = resolveSkillUsageDiagnosisSessionPrefs({
      agentKind: 'codex', prefs: { ...prefs, providerId: 'account-a' }, modelChosenByUser: true,
      providers: [provider('codex')], providersLoading: false, capabilities,
      effortForModel: vi.fn(), fastForModel: vi.fn(), legacyFastForModel: () => false,
    });
    expect(result).toMatchObject({ providerId: 'account-a', model: 'selected', effort: 'high' });
  });

  it('disables Fast when either the actual provider model or harness does not support it', () => {
    for (const [modelFast, harnessFast] of [[false, true], [true, false]]) {
      const result = resolveSkillUsageDiagnosisSessionPrefs({
        agentKind: 'pi', prefs, modelChosenByUser: true,
        providers: [provider('pi', { supportsFastMode: modelFast })], providersLoading: false,
        capabilities: { ...capabilities, hasFastMode: harnessFast },
        effortForModel: vi.fn(), fastForModel: () => true, legacyFastForModel: () => true,
      });
      expect(result.fastMode).toBe(false);
    }
  });
});

describe('diagnosis engine selection', () => {
  it('uses recent available engine and locally falls back from Orca or an unavailable engine', () => {
    expect(selectDiagnosisAgent('pi', new Set(['cc', 'pi']), true)).toBe('pi');
    expect(selectDiagnosisAgent('orca', new Set(['codex', 'pi']), true)).toBe('codex');
    expect(selectDiagnosisAgent('cc', new Set(['pi']), true)).toBe('pi');
    expect(selectDiagnosisAgent('cc', new Set(), true)).toBeNull();
  });
  it('keeps valid engine choices available while discovery is unknown or failed', () => {
    expect(selectDiagnosisAgent('pi', new Set(), false)).toBe('pi');
    expect(selectDiagnosisAgent('orca', new Set(), false)).toBe('cc');
  });
});
