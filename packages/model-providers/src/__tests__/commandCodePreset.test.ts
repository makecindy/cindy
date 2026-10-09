import { describe, expect, it } from 'vitest';

import { BUNDLED_CATALOG } from '../catalog.js';
import { modelProtocolComparison } from '../modelProtocol.js';
import { providerSetupLink } from '../providerSetupLinks.js';
import { buildUserProvider } from '../user-provider.js';
import type { AgentKind, CustomProviderConfig } from '../types.js';

const agents: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];

/**
 * Command Code 公开目录实读快照（`https://api.commandcode.ai/provider/v1/models`，2026-10-09，共 87 条）。
 *
 * `supported_endpoints` 是官方逐模型接口声明：Claude 型号只在 `/messages` 上服务，Claude 型号与
 * 其它型号互投别的路由都会被上游 400（官方 Provider 文档「Supported endpoints and formats」）。
 * 目录（`providers.json` 的 `command-code` 预设）与这份映射必须一起改：预设增减型号、或把型号写到
 * 官方没有声明的协议上，本文件就会失败。
 */
const supportedEndpoints: Record<string, readonly string[]> = {
  'claude-sonnet-5': ['/messages'],
  'claude-opus-5': ['/messages'],
  'claude-haiku-4-5-20251001': ['/messages'],
  'gpt-5.3-codex': ['/chat/completions', '/responses'],
  'gpt-5.5': ['/chat/completions', '/responses'],
  'gpt-5.4-mini': ['/chat/completions', '/responses'],
  'xai/grok-4.6': ['/chat/completions', '/responses'],
  'deepseek/deepseek-v4-pro': ['/chat/completions', '/responses'],
  'z-ai/glm-5.3-flash': ['/chat/completions', '/responses'],
  'moonshotai/Kimi-K2.7-Code': ['/chat/completions', '/responses'],
  'MiniMaxAI/MiniMax-M3': ['/chat/completions', '/responses'],
  'xiaomi/mimo-v2.6-pro': ['/chat/completions', '/responses'],
  'google/gemini-3.8-flash': ['/chat/completions', '/responses'],
  'Qwen/Qwen3.8-Flash': ['/chat/completions'],
};

/** 官方只在 Messages 上服务的 Claude 型号；其余型号官方不提供 Messages。 */
const claudeModels = ['claude-sonnet-5', 'claude-opus-5', 'claude-haiku-4-5-20251001'];
const sorted = (values: readonly string[]) => [...values].sort();

const preset = BUNDLED_CATALOG.presets?.find((candidate) => candidate.id === 'command-code');
const options = { presets: BUNDLED_CATALOG.presets, modelRegistry: BUNDLED_CATALOG.modelRegistry };

/** 协议决定渠道请求路径的固定后缀（Messages 补 `/v1/messages`、Chat 补 `/chat/completions`、Responses 补 `/responses`）。 */
function channelPath(baseUrl: string, api: string): string {
  const path = new URL(baseUrl).pathname.replace(/\/+$/, '');
  if (api === 'anthropic-messages') return path + '/v1/messages';
  if (api === 'openai-chat' || api === 'openai-completions') return path + '/chat/completions';
  return path + '/responses';
}

function imported() {
  const config: CustomProviderConfig = {
    id: 'command-code-test',
    name: 'Command Code',
    runtimes: Object.fromEntries(agents.map((agent) => [agent, {
      ...preset!.runtimes[agent]!,
      catalogPresetId: preset!.id,
      models: preset!.runtimes[agent]!.models.map(({ defaultEnabled: _selection, ...model }) => model),
    }])) as CustomProviderConfig['runtimes'],
  };
  return buildUserProvider(config, options);
}

describe('Command Code 供应商预设', () => {
  it('可从「添加供应商」向导发现，并指向官方 API Key 页', () => {
    expect(preset).toBeDefined();
    expect(preset).toMatchObject({
      name: 'Command Code',
      docsUrl: 'https://commandcode.ai/docs/provider',
      regionHint: 'global',
    });
    expect(preset?.authMethod ?? 'apiKey').toBe('apiKey');
    expect(providerSetupLink(preset!)).toEqual({
      url: 'https://commandcode.ai/settings/keys',
      kind: 'apiKey',
    });
  });

  it('三个运行时的地址与官方 Provider API 地址一致', () => {
    expect(preset!.runtimes['claude-code']).toMatchObject({
      baseUrl: 'https://api.commandcode.ai/provider',
    });
    expect(preset!.runtimes.codex).toMatchObject({
      baseUrl: 'https://api.commandcode.ai/provider/v1',
    });
    expect(preset!.runtimes.pi).toMatchObject({
      baseUrl: 'https://api.commandcode.ai/provider/v1',
      wireProtocol: 'openai-chat',
    });
    for (const agent of agents) {
      expect(preset!.runtimes[agent]!.modelsUrl, agent).toBe('https://api.commandcode.ai/provider/v1/models');
    }
  });

  it('目录只声明快照里的型号，快照也只覆盖目录声明的型号', () => {
    const declared = agents.flatMap((agent) => preset!.runtimes[agent]!.models.map((model) => model.id));
    expect(sorted(declared)).toEqual(sorted(Object.keys(supportedEndpoints)));
  });

  it('Claude Code 运行时只放官方仅在 /messages 服务的 Claude 型号', () => {
    expect(sorted(preset!.runtimes['claude-code']!.models.map((model) => model.id))).toEqual(sorted(claudeModels));
    for (const model of preset!.runtimes['claude-code']!.models) {
      expect(supportedEndpoints[model.id], model.id).toEqual(['/messages']);
    }
  });

  it('Codex 运行时不放 Claude 型号，并且只在官方没有 /responses 时改用逐模型 Chat 路由', () => {
    const runtime = preset!.runtimes.codex!;
    expect(runtime.wireProtocol).toBeUndefined();
    const expected = sorted(Object.keys(supportedEndpoints).filter((id) => !claudeModels.includes(id)));
    expect(sorted(runtime.models.map((model) => model.id))).toEqual(expected);
    for (const model of runtime.models) {
      expect(supportedEndpoints[model.id], model.id).not.toContain('/messages');
      if (supportedEndpoints[model.id]!.includes('/responses')) {
        // Responses 是 Codex 的原生协议，原生可用就不额外声明路由。
        expect(model.route, model.id).toBeUndefined();
        expect(model.api, model.id).toBeUndefined();
      } else {
        expect(model, model.id).toMatchObject({
          api: 'openai-completions',
          route: {
            baseUrl: 'https://api.commandcode.ai/provider/v1',
            wireProtocol: 'openai-chat',
          },
        });
      }
    }
  });

  it('Pi 用 Messages 适配器跟随 Claude 型号，其余型号保持渠道默认 Chat', () => {
    const runtime = preset!.runtimes.pi!;
    for (const model of runtime.models) {
      if (supportedEndpoints[model.id]!.includes('/messages')) {
        expect(model, model.id).toMatchObject({
          piApi: 'anthropic-messages',
          route: {
            baseUrl: 'https://api.commandcode.ai/provider',
            wireProtocol: 'anthropic-messages',
          },
        });
      } else {
        expect(model.piApi, model.id).toBeUndefined();
        expect(model.route, model.id).toBeUndefined();
      }
    }
  });

  it.each(agents)('%s 每个型号解析出的上游路径都落在官方 supported_endpoints 上', (agent) => {
    const provider = imported();
    const models = provider.models[agent] ?? [];
    expect(models.length, agent).toBeGreaterThan(0);
    for (const model of models) {
      const outbound = modelProtocolComparison(provider, { [agent]: model }).forAgent(agent)?.outbound;
      expect(outbound, agent + '/' + model.id + ' 出站协议').toBeTruthy();
      const baseUrl = model.route?.baseUrl ?? provider.routing[agent]!.upstream;
      expect(new URL(baseUrl).host, baseUrl).toBe('api.commandcode.ai');
      const path = channelPath(baseUrl, outbound!);
      expect(
        supportedEndpoints[model.id]!.some((endpoint) => path.endsWith(endpoint)),
        agent + '/' + model.id + ' → ' + path,
      ).toBe(true);
    }
  });

  it('原生引擎默认开启、供应方转换默认关闭、Pi 全部默认可用', () => {
    const provider = imported();
    const enabled = (agent: AgentKind) =>
      sorted((provider.models[agent] ?? []).filter((model) => model.defaultEnabled).map((model) => model.id));
    // Claude 型号是 Messages 原生，Claude Code 上默认开启；反向型号根本不进这个运行时。
    expect(enabled('claude-code')).toEqual(sorted(claudeModels));
    // Codex harness 只说 Responses：只有 Responses 原生型号默认开启，供应方转换来的默认关闭但依然可选。
    for (const model of provider.models.codex ?? []) {
      expect(model.defaultEnabled, model.id).toBe(model.nativeApi === 'openai-responses');
    }
    expect(enabled('codex').length).toBeGreaterThan(0);
    expect(enabled('codex').length).toBeLessThan((provider.models.codex ?? []).length);
    // Pi 直接说上游 adapter，全部型号默认可用。
    expect(enabled('pi')).toEqual(sorted(Object.keys(supportedEndpoints)));
  });
});

