import { describe, expect, it } from 'vitest';
import { BUNDLED_CATALOG, buildUserProvider, type AgentKind } from '@cindy/model-providers';
import { buildTextOneshotPinOptions, decodeCatalogPin } from '../textOneshotPinOptions.js';
import { resolveDirectTextRoute } from '../directTextRoute.js';
import { normalizeAuxiliaryModelList } from '../../../shared/auxiliaryModelSettings.js';

const modelId = 'deepseek-v4.1-flash';
const preset = BUNDLED_CATALOG.presets!.find((entry) => entry.id === 'opencode-go')!;

function go(agents: AgentKind[] = ['claude-code', 'codex', 'pi'], enabled?: boolean) {
  return buildUserProvider({ id: 'go', name: 'OpenCode Go', runtimes: Object.fromEntries(
    agents.map((agent) => [agent, {
      ...preset.runtimes[agent], catalogPresetId: preset.id,
      models: [{ id: modelId, name: 'DeepSeek', ...(enabled !== undefined ? { defaultEnabled: enabled } : {}) }],
    }]),
  ) }, { presets: BUNDLED_CATALOG.presets });
}

describe('auxiliary direct HTTP admission', () => {
  it.each([['pi'], ['claude-code', 'codex', 'pi']] as AgentKind[][])(
    'offers Go Flash without enabling chat compatibility (%j)', (...agents) => {
      const provider = go(agents);
      const catalog = { ...BUNDLED_CATALOG, providers: [provider] };
      const before = structuredClone(provider);
      const options = buildTextOneshotPinOptions(catalog, undefined, undefined, () => true, 'auxiliary');
      expect(options).toHaveLength(agents.length);
      expect(options.every((option) => option.defaultEnabled)).toBe(true);
      expect(normalizeAuxiliaryModelList(options.map((option) => option.id))).toEqual(options.map((option) => option.id));
      expect(provider).toEqual(before);
      if (agents.includes('codex')) expect(provider.models.codex![0].defaultEnabled).toBe(false);
      for (const option of options) {
        expect(resolveDirectTextRoute(provider, option.agentKind, provider.models[option.agentKind]![0])).toMatchObject({
          upstream: 'https://opencode.ai/zen/go/v1', wireProtocol: 'openai-chat',
        });
      }
    },
  );

  it('preserves explicit model defaults, disable overrides, credentials and plugin admission', () => {
    const provider = go(['pi'], false);
    const catalog = { ...BUNDLED_CATALOG, providers: [provider] };
    expect(buildTextOneshotPinOptions(catalog, undefined, undefined, () => true, 'auxiliary')[0].defaultEnabled).toBe(false);
    expect(buildTextOneshotPinOptions(catalog, undefined, undefined, () => false, 'auxiliary')).toEqual([]);
    expect(buildTextOneshotPinOptions(catalog, { disabledModels: { [`${provider.id}:${modelId}`]: true } }, undefined, () => true, 'auxiliary')).toEqual([]);
    expect(buildTextOneshotPinOptions(catalog, { disabledProviders: { [provider.id]: true } }, undefined, () => true, 'auxiliary')).toEqual([]);
    expect(buildTextOneshotPinOptions(catalog, undefined)).toEqual([
      expect.objectContaining({ agentKind: 'pi', defaultEnabled: false }),
    ]);
    expect(decodeCatalogPin('cat:go:pi:deepseek-v4.1-flash')).toEqual({
      providerId: 'go', agentKind: 'pi', model: modelId,
    });
  });

  it.each(['google-generative-ai', 'bedrock-converse-stream', 'azure-openai-responses'] as const)(
    'does not offer unsupported SDK API %s even when the connection defaults to Chat', (api) => {
      const provider = go(['pi']);
      provider.models.pi![0].api = api;
      expect(buildTextOneshotPinOptions({ ...BUNDLED_CATALOG, providers: [provider] }, undefined, undefined, () => true, 'auxiliary')).toEqual([]);
    },
  );

  it('pairs model protocol, address and path without inheriting the connection path', () => {
    const provider = go(['codex']);
    provider.routing.codex!.requestPath = '/old/chat';
    const model = provider.models.codex![0];
    model.api = 'anthropic-messages';
    model.route = { baseUrl: 'https://messages.example', wireProtocol: 'anthropic-messages', requestPath: '/tenant/messages' };
    expect(resolveDirectTextRoute(provider, 'codex', model)).toMatchObject({
      upstream: 'https://messages.example', wireProtocol: 'anthropic-messages', requestPath: '/tenant/messages',
    });
    delete model.route.requestPath;
    expect(resolveDirectTextRoute(provider, 'codex', model)?.requestPath).toBeUndefined();
  });

  it('inherits the connection path only while the effective address and protocol are unchanged', () => {
    const provider = go(['codex']);
    const routing = provider.routing.codex!;
    routing.requestPath = '/tenant/completions';
    const model = provider.models.codex![0];
    expect(model.route?.baseUrl).toBe(routing.upstream);
    expect(resolveDirectTextRoute(provider, 'codex', model)?.requestPath).toBe('/tenant/completions');
    model.route!.requestPath = '/model/completions';
    expect(resolveDirectTextRoute(provider, 'codex', model)?.requestPath).toBe('/model/completions');
    delete model.route!.requestPath;
    model.route!.baseUrl = 'https://other.example/v1';
    expect(resolveDirectTextRoute(provider, 'codex', model)?.requestPath).toBeUndefined();
    model.route!.baseUrl = routing.upstream;
    model.route!.wireProtocol = 'openai-responses';
    model.api = 'openai-responses';
    expect(resolveDirectTextRoute(provider, 'codex', model)?.requestPath).toBeUndefined();
  });
});
