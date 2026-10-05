import { describe, expect, it, vi } from 'vitest';
import { createSessionExecutionResolver, type SessionExecutionResolverDeps } from '../sessionExecutionSelection';

const caller = { agentKind: 'codex' as const, model: 'gpt-6-astra', providerId: 'openai', effort: 'high' as const, fastMode: false };
const panel = { agentKind: 'pi' as const, model: 'z-ai/glm-5.3-flash', providerId: 'xd', effort: 'medium' as const, fastMode: false };
const metadata = (id: string) => ({ id, efforts: ['medium', 'high'], defaultEffort: 'medium', supportsFastMode: false });
const routing = {
  availability: {
    codex: [{ id: 'openai', name: 'OpenAI', models: [caller.model] }],
    pi: [{ id: 'xd', name: 'Cindy AI', models: [panel.model] }],
    'claude-code': [{ id: 'xd', name: 'Cindy AI', models: [panel.model] }, { id: 'glm', name: 'GLM', models: ['glm-5.3'] }],
  },
  resolveDefaultProviderIdForModel: (agent: string, model: string) =>
    routing.availability[agent as keyof typeof routing.availability]?.find(p => p.models.includes(model))?.id ?? null,
};
function setup(overrides: Partial<SessionExecutionResolverDeps> = {}) {
  const deps: SessionExecutionResolverDeps = {
    captureOwner: () => () => {}, readCaller: vi.fn(async () => caller), readDefault: vi.fn(() => panel),
    availableAgents: () => ['codex', 'claude-code', 'pi'],
    availableModels: agent => agent === 'codex' ? [metadata(caller.model)] : [metadata(panel.model), metadata('glm-5.3')],
    readProviderRouting: async () => routing, hasCindyAiApiKey: () => true, ...overrides,
  };
  return { deps, resolve: createSessionExecutionResolver(deps) };
}

describe('ordinary Session model selection', () => {
  it('inherits a complete caller route; no old CC draft or permission is read', async () => {
    const { deps, resolve } = setup();
    expect(await resolve({}, 'caller')).toEqual(caller);
    expect(deps.readDefault).not.toHaveBeenCalled();
  });
  it('panel creation follows the selected engine and provider as one tuple', async () => {
    const { deps, resolve } = setup();
    expect(await resolve({})).toEqual(panel);
    expect(deps.readCaller).not.toHaveBeenCalled();
  });
  it('an explicit plugin selection works independently of a missing caller', async () => {
    const { deps, resolve } = setup({ readCaller: vi.fn(async () => { throw Error('gone'); }) });
    expect(await resolve(caller, 'caller')).toEqual(caller);
    expect(deps.readCaller).not.toHaveBeenCalled();
  });
  it('preserves a user-repaired existing task across default-model changes', async () => {
    const { deps, resolve } = setup();
    expect(await resolve({}, undefined, caller)).toEqual(caller);
    expect(deps.readDefault).not.toHaveBeenCalled();
  });
  it('does not treat a valid GLM catalog model as invalid because SDK logs add a wire suffix', async () => {
    expect(await setup().resolve({ agentKind: 'cc', model: panel.model, providerId: 'xd' }))
      .toMatchObject({ agentKind: 'claude-code', model: panel.model, providerId: 'xd' });
  });
  it('rejects a withdrawn model on creation and reuse instead of substituting one', async () => {
    const { resolve } = setup();
    const invalid = { agentKind: 'cc' as const, model: 'withdrawn-model', providerId: 'xd' };
    await expect(resolve(invalid)).rejects.toThrow('not available');
    await expect(resolve({}, undefined, invalid)).rejects.toThrow('不会自动更换');
  });
  it('does not borrow credentials from an unrelated model/provider route', async () => {
    await expect(setup().resolve({ agentKind: 'cc', model: panel.model, providerId: 'glm' })).rejects.toThrow('不再为');
  });
  it('rejects disconnected saved routes and unavailable Agents', async () => {
    const disconnected = setup({ readProviderRouting: async () => ({ ...routing, availability: { ...routing.availability, codex: [] } }) });
    await expect(disconnected.resolve({}, 'caller')).rejects.toThrow('没有已连接');
    await expect(setup({ availableAgents: () => ['pi'] }).resolve({}, 'caller')).rejects.toThrow('Agent codex');
  });
  it('validates requested tuning with the selected provider', async () => {
    await expect(setup().resolve({ effort: 'ultra' }, 'caller')).rejects.toThrow('not supported');
    await expect(setup().resolve({ fastMode: true }, 'caller')).rejects.toThrow('fast mode is not supported');
  });
  it('preserves old partial overrides without mixing unrelated source credentials', async () => {
    expect(await setup().resolve({ agentKind: 'cc', model: 'glm-5.3' }))
      .toMatchObject({ providerId: 'glm', model: 'glm-5.3', effort: 'medium' });
  });
  it('supports models without a reasoning selector instead of inventing high', async () => {
    const { resolve } = setup({ availableModels: () => [{ id: 'glm-5.3', efforts: [] }] });
    expect(await resolve({ agentKind: 'cc', model: 'glm-5.3', providerId: 'glm' })).toMatchObject({ effort: undefined });
  });
  it('does not silently choose a hardcoded model when default selection is missing', async () => {
    await expect(setup({ readDefault: () => undefined }).resolve({})).rejects.toThrow('尚未选择');
  });
  it('rejects owner changes during provider lookup', async () => {
    let changed = false;
    const { resolve } = setup({ captureOwner: () => () => { if (changed) throw Error('owner changed'); },
      readProviderRouting: async () => { changed = true; return routing; } });
    await expect(resolve({})).rejects.toThrow('owner changed');
  });
});
