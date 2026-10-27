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
 * 官方没有声明的端点上，本文件就会失败。
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
const allModels = sorted(Object.keys(supportedEndpoints));
const chatRoute = { baseUrl: 'https://api.commandcode.ai/provider/v1', wireProtocol: 'openai-chat' };

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

  it('快照只覆盖预设声明的型号，预设也不声明快照外的型号', () => {
    const declared = agents.flatMap((agent) => preset!.runtimes[agent]!.models.map((model) => model.id));
    expect(sorted([...new Set(declared)])).toEqual(allModels);
  });

  // 连接后的「刷新模型」会把渠道目录里的型号追加进所选引擎。预设把每个推荐型号都声明到三个引擎，
  // 刷新就不会造出「渠道不服务的型号 + 引擎默认协议」这种必然失败、又要用户自己排查的组合。
  it.each(agents)('%s 运行时声明全部推荐型号，各自带该引擎的上游路由', (agent) => {
    expect(sorted(preset!.runtimes[agent]!.models.map((model) => model.id)), agent).toEqual(allModels);
  });

  it('Claude 型号在三个引擎上都指向官方唯一的 /messages 端点', () => {
    for (const agent of agents) {
      for (const model of preset!.runtimes[agent]!.models) {
        if (!claudeModels.includes(model.id)) continue;
        expect(model.api ?? model.piApi, agent + '/' + model.id + ' 出站协议').toBe('anthropic-messages');
        expect(model.route, agent + '/' + model.id + ' 路由').toMatchObject({
          baseUrl: 'https://api.commandcode.ai/provider',
          wireProtocol: 'anthropic-messages',
        });
      }
    }
  });

  it('Codex 只在官方没有 /responses 时改用逐模型 Chat 路由', () => {
    const runtime = preset!.runtimes.codex!;
    expect(runtime.wireProtocol).toBeUndefined();
    for (const model of runtime.models) {
      if (claudeModels.includes(model.id)) continue;
      if (supportedEndpoints[model.id]!.includes('/responses')) {
        expect(model.api, model.id).toBeUndefined();
        expect(model.route, model.id).toBeUndefined();
      } else {
        expect(model, model.id).toMatchObject({ api: 'openai-completions', route: chatRoute });
      }
    }
  });

  it('Claude Code 对非 Claude 型号走渠道的 Chat 端点', () => {
    for (const model of preset!.runtimes['claude-code']!.models) {
      if (claudeModels.includes(model.id)) continue;
      expect(model, model.id).toMatchObject({ api: 'openai-completions', route: chatRoute });
    }
  });

  it('Pi 对 Claude 型号用 Messages adapter，其余保持渠道默认 Chat', () => {
    const runtime = preset!.runtimes.pi!;
    for (const model of runtime.models) {
      if (claudeModels.includes(model.id)) continue;
      expect(model.piApi, model.id).toBeUndefined();
      expect(model.route, model.id).toBeUndefined();
    }
  });

  it.each(agents)('%s 每个型号解析出的上游路径都落在官方 supported_endpoints 上', (agent) => {
    const provider = imported();
    const models = provider.models[agent] ?? [];
    expect(models.length, agent).toBeGreaterThan(0);
    for (const model of models) {
      const outbound = modelProtocolComparison(provider, Object.fromEntries([[agent, model]]))
        .forAgent(agent)?.outbound;
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

  it('原生组合默认开启、跨协议桥接默认关闭、Pi 全部默认可用', () => {
    const provider = imported();
    const enabled = (agent: AgentKind) =>
      sorted((provider.models[agent] ?? []).filter((model) => model.defaultEnabled).map((model) => model.id));
    // Claude 是 Messages 原生，Claude Code 上默认开启；其余型号经本地桥接、默认关闭但仍可选。
    expect(enabled('claude-code')).toEqual(sorted(claudeModels));
    // Codex harness 只说 Responses：只有 Responses 原生型号默认开启。
    for (const model of provider.models.codex ?? []) {
      expect(model.defaultEnabled, model.id).toBe(model.nativeApi === 'openai-responses');
    }
    const codexModels = provider.models.codex ?? [];
    expect(enabled('codex').length).toBeGreaterThan(0);
    expect(enabled('codex').length).toBeLessThan(codexModels.length);
    // Pi 直接说上游 adapter，全部型号默认可用。
    expect(enabled('pi')).toEqual(allModels);
  });
});
