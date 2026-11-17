import { describe, expect, it, vi } from 'vitest';
import { createSessionExecutionResolver, type SessionExecutionResolverDeps } from '../sessionExecutionSelection';
import { createGhostAgentTurnRunner, type GhostAgentTurnRunnerDeps } from '../ghostAgentTurnRunner';
import { GhostAgentSlot } from '../../cindy-brain/agentSlot';
import type { InstalledGhost } from '../../../shared/ghost';

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
  it('creates a task on an undeclared custom Anthropic Messages model when the draft carries medium (#5535)', async () => {
    // 复现 #5535:自定义来源模型只有 id/name,草稿 effort 预填 medium,之前被当成 valid: none 拒绝。
    const model = 'custom/step-5-preview';
    const custom = {
      availability: {
        ...routing.availability,
        'claude-code': [{
          id: 'custom-anthropic', name: 'Custom Anthropic Messages', models: [model],
          effortMetaByModel: { [model]: { efforts: [], defaultEffort: null, effortsUnknown: true } },
          requiresExplicitRoute: true,
        }],
      },
      resolveDefaultProviderIdForModel: (agent: string, id: string) =>
        agent === 'claude-code' && id === model ? 'custom-anthropic' : null,
    };
    const { resolve } = setup({
      availableModels: () => [{ id: model, efforts: [], defaultEffort: null, effortsUnknown: true }],
      readProviderRouting: async () => custom,
    });
    await expect(resolve({ agentKind: 'cc', model, providerId: 'custom-anthropic', effort: 'medium' }))
      .resolves.toEqual({ agentKind: 'claude-code', model, providerId: 'custom-anthropic', effort: 'medium', fastMode: false });
    // 重启后草稿还在:同一选择重复提交仍可创建,模型与来源都不被替换。
    await expect(resolve({ agentKind: 'cc', model, providerId: 'custom-anthropic', effort: 'medium' }))
      .resolves.toMatchObject({ model, providerId: 'custom-anthropic', effort: 'medium' });
    // 已声明的空档位(reasoning:false)仍拒绝显式 medium,不被「未知」放行误伤。
    const { resolve: resolveDeclared } = setup({
      availableModels: () => [{ id: model, efforts: [], defaultEffort: null }],
      readProviderRouting: async () => ({
        ...custom,
        availability: { ...custom.availability, 'claude-code': [{ ...custom.availability['claude-code'][0]!,
          effortMetaByModel: { [model]: { efforts: [], defaultEffort: null } } }] },
      }),
    });
    await expect(resolveDeclared({ agentKind: 'cc', model, providerId: 'custom-anthropic', effort: 'medium' }))
      .rejects.toThrow('valid: none');
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

// #9489: existing selection tests never exercised the production plugin runner.
// A remote-only provider was rejected before delivery. These unit cases execute
// the runner with real local admission, observing delivery/results without a live Agent.
describe('plugin runner execution location admission (#9489)', () => {
  function runnerFixture(location: 'local' | 'device' | 'share' | 'ssh', busy = false) {
    const source = {
      ...caller,
      providerId: location === 'local' ? caller.providerId : 'remote-only-provider',
      remoteHostId: location === 'ssh' ? 'ssh-host' : undefined,
      agentDeviceId: location === 'device' ? 'other-computer' : location === 'share' ? 'share:provider' : undefined,
    };
    const { resolve } = setup({ readCaller: async () => source });
    const deps: GhostAgentTurnRunnerDeps = {
      readSessionMeta: vi.fn(async () => source),
      admitLocalSession: vi.fn(id => resolve({}, id)),
      readPluginName: () => 'GitHub',
      send: vi.fn<GhostAgentTurnRunnerDeps['send']>(async params => ({ ok: true, targetSessionId: params.targetSessionId ?? 'new-task',
        wakeKind: busy ? 'queued' : params.targetSessionId ? 'resumed' : 'created' })),
      readLatestAssistant: vi.fn(async () => ({ clientId: 'last-assistant' })),
      forkSessionAtMessage: vi.fn(async () => ({ id: 'forked-task' })),
      broadcastSessionCreated: vi.fn(),
    };
    const runner = createGhostAgentTurnRunner(deps);
    const request = { ghostId: 'github', ghostVersion: '1.5.5', sourceSessionId: 'original-task',
      mode: 'continue' as const, prompt: 'Create a draft PR', persistedContent: 'visible request' };
    return { deps, runner, request, source };
  }

  it.each(['local', 'device', 'share', 'ssh'] as const)(
    'delivers idle and busy %s tasks without overriding their route or permissions', async location => {
      for (const busy of [false, true]) {
        const f = runnerFixture(location, busy);
        const original = { ...f.source };
        expect(await f.runner(f.request)).toEqual({ ok: true, sessionId: 'original-task', disposition: busy ? 'queued' : 'resumed' });
        expect(f.deps.send).toHaveBeenCalledExactlyOnceWith({
          sourcePlugin: { pluginId: 'github', name: 'GitHub' }, targetSessionId: 'original-task',
          message: f.request.prompt, persistedContent: f.request.persistedContent,
          resumeWithStoredPermissionMode: true,
        });
        expect(f.source).toEqual(original);
        expect(f.deps.admitLocalSession).toHaveBeenCalledTimes(location === 'local' ? 1 : 0);
      }
    },
  );

  it('still rejects an unavailable local provider without delivery or substitution', async () => {
    const f = runnerFixture('local');
    f.source.providerId = 'removed-provider';
    expect(await f.runner(f.request)).toMatchObject({ ok: false, errorCode: 'MODEL_UNAVAILABLE', message: expect.stringContaining('不会自动更换') });
    expect(f.deps.send).not.toHaveBeenCalled();
    expect(f.source.providerId).toBe('removed-provider');
  });

  it('returns the real remote delivery failure instead of a local model error', async () => {
    const f = runnerFixture('share');
    const failure = { ok: false as const, errorCode: 'PROVIDER_ROUTE_UNAVAILABLE', message: 'Shared provider access was revoked' };
    vi.mocked(f.deps.send).mockResolvedValueOnce(failure);
    expect(await f.runner(f.request)).toEqual(failure);
    expect(f.deps.send).toHaveBeenCalledOnce();
  });

  it('preserves click authorization, diagnostic messages and single-use tickets through the real runner', async () => {
    const f = runnerFixture('device');
    vi.mocked(f.deps.send).mockResolvedValue({ ok: false, errorCode: 'PROVIDER_ROUTE_UNAVAILABLE', message: 'Execution computer unavailable' });
    const slot = new GhostAgentSlot({ runner: f.runner, getGhost: () => ({ enabled: true,
      manifest: { id: 'github', version: '1.5.5', agent: {} } } as InstalledGhost) });
    const token = slot.issueUserActionToken('github', 'original-task')!;
    const request = { type: 'agent-request', mode: 'continue', promptTemplate: '{{user_message}}', userMessage: 'Create a draft PR', userActionToken: token };
    expect(await slot.handleRequest('different-plugin', request)).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED' });
    expect(f.deps.send).not.toHaveBeenCalled();
    expect(await slot.handleRequest('github', request)).toMatchObject({ ok: false, message: 'Execution computer unavailable' });
    expect(await slot.handleRequest('github', request)).toMatchObject({ ok: false, errorCode: 'TOKEN_EXPIRED' });
    expect(f.deps.send).toHaveBeenCalledOnce();
  });

  it('keeps new-task permission inheritance and forks from the latest assistant after extraction', async () => {
    const f = runnerFixture('local');
    expect(await f.runner({ ...f.request, mode: 'new', title: 'Draft PR' })).toMatchObject({ ok: true, sessionId: 'new-task', disposition: 'created' });
    expect(f.deps.send).toHaveBeenLastCalledWith({ sourcePlugin: { pluginId: 'github', name: 'GitHub' },
      dispatcherSessionId: 'original-task', message: f.request.prompt, persistedContent: f.request.persistedContent,
      inheritSourcePermissionMode: true, title: 'Draft PR' });
    expect(await f.runner({ ...f.request, mode: 'fork' })).toEqual({ ok: true, sessionId: 'forked-task', disposition: 'forked' });
    expect(f.deps.forkSessionAtMessage).toHaveBeenCalledExactlyOnceWith('original-task', 'last-assistant');
    expect(f.deps.send).toHaveBeenLastCalledWith({ sourcePlugin: { pluginId: 'github', name: 'GitHub' },
      targetSessionId: 'forked-task', message: f.request.prompt, persistedContent: f.request.persistedContent,
      resumeWithStoredPermissionMode: true });
  });
});
