/**
 * providerListProjection.test.ts — 被控端隧道 `maker:provider:list` 返回投影契约。
 * -------------------------------------------------------------------------------------
 * 背景:控制端远程会话曾靠 `provider.routing[agent].supportsFastMode` 决定显隐 Fast 开关,
 * 故投影需保留该字段。**现 Fast 能力已收归 per-(provider, agent) 的 `models[agent].supportsFastMode`
 * (唯一真相)**,控制端从隧道带来的 `models` 现查、不再读 routing,于是投影把 routing 的
 * 执行字段整条剥掉，只保留跨端可用性需要的 `disabled:true` 与可选 wireProtocol。
 * 本测试锁住五件事:
 *   1. 执行细节字段(upstream / authStrategy / headerDelete / headerOverride / modelIdRewrite /
 *      adapter) → 投影后全部消失(安全边界 D3)。
 *   2. 即便输入里残留 supportsFastMode → 也一并剥掉(routing 不再承载任何 Fast 信息)。
 *   3. models[agent](含 supportsFastMode 显示门控)原样透传 —— Fast 显隐数据源在这里。
 *   4. disabled runtime 在控制端仍保持禁用，不会被共享 registry 重新列为可选。
 *   5. 品牌只以非敏感 logoKind 透传;重命名 preset 仍可识别,upstream 绝不泄漏。
 * 只 mock electron(app)+ logger,与同目录 dispatchSendSafety.test 同范式。
 */
import { describe, it, expect, vi } from 'vitest';
import { connectedProvidersForAgent, type ProviderView } from '@cindy/model-providers';
import { TEST_XD_GATEWAY_BASE_URL as XD_GATEWAY_BASE_URL } from '../../../test/vitest/clientEndpointsFixture';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/xdt-maker-test/app',
    getPath: () => '/tmp/xdt-maker-test',
    getVersion: () => '0.0.0-test',
  },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  // notificationService.ts 顶层 IIFE 在 !isPackaged 时调 nativeImage.createFromPath
  // (经 scheduler-host 传递性 import 被拉进来),补桩避免 collect 阶段报 mock 未定义
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { __testing } from '../dispatch';

const project = (result: unknown) =>
  __testing.projectInvokeResultForTunnel('maker:provider:list', result) as {
    providers: Record<string, unknown>[];
    modelVisibilityOverrides?: Record<string, boolean>;
  };
const projectForCurrentController = (result: unknown) =>
  __testing.projectInvokeResultForTunnel('maker:provider:list', result, true) as {
    providers: Record<string, unknown>[];
    modelVisibilityOverrides?: Record<string, boolean>;
  };

describe('controller capability metadata', () => {
  it('distinguishes an absent subscribe field from an explicit empty capability set', () => {
    expect(__testing.optionalControllerCapabilities({})).toBeUndefined();
    expect(__testing.optionalControllerCapabilities({ capabilities: [] })).toEqual([]);
    expect(
      __testing.optionalControllerCapabilities({
        capabilities: ['provider-logo-kinds-v2', 42, 'provider-logo-kinds-v2'],
      }),
    ).toEqual(['provider-logo-kinds-v2']);
  });
});

/** 一个带完整 routing(含执行机密 + 残留 supportsFastMode)+ per-provider models 的被控端 provider。仿 XD 网关。 */
function xdProviderWithFullRouting() {
  return {
    id: 'xd',
    name: 'XD Gateway',
    connected: true,
    agents: ['claude-code', 'codex'],
    routing: {
      'claude-code': {
        upstream: XD_GATEWAY_BASE_URL,
        authStrategy: 'gateway-key',
        headerDelete: ['anthropic-beta'],
        headerOverride: { 'x-secret': 'leak-me' },
        modelIdRewrite: { stripPrefix: 'codex/' },
        adapter: 'someAdapter',
        supportsFastMode: false, // 残留旧字段,投影应一并剥掉(routing 不再承载 Fast 信息)
      },
      codex: {
        upstream: `${XD_GATEWAY_BASE_URL}/v1`,
        authStrategy: 'gateway-key',
      },
    },
    models: {
      'claude-code': [
        {
          id: 'claude-opus-4-8',
          name: 'Opus 4.8',
          contextWindow: 1000000,
          efforts: [],
          defaultEffort: null,
          supportsFastMode: true,
        },
      ],
    },
  };
}

describe('projectInvokeResultForTunnel — maker:provider:list 投影', () => {
  it('剥掉全部执行细节字段（安全边界 D3:upstream / 密钥 / endpoint 不出被控端）', () => {
    const { providers } = project({ providers: [xdProviderWithFullRouting()] });
    const cc = (providers[0].routing as Record<string, Record<string, unknown>>)['claude-code'];
    for (const secret of [
      'upstream',
      'authStrategy',
      'headerDelete',
      'headerOverride',
      'modelIdRewrite',
      'adapter',
    ]) {
      expect(cc).not.toHaveProperty(secret);
    }
    // claude-code 路由投影后是空对象(连残留的 supportsFastMode 也被剥掉)。
    expect(cc).toEqual({});
  });

  it('残留的 supportsFastMode 也被剥掉（routing 不再承载 Fast 信息）', () => {
    const { providers } = project({ providers: [xdProviderWithFullRouting()] });
    const routing = providers[0].routing as Record<string, Record<string, unknown>>;
    expect(routing['claude-code']).not.toHaveProperty('supportsFastMode');
    expect(routing.codex).toEqual({});
  });

  it('只保留 openai-chat 兼容展示标记，仍不泄漏执行细节', () => {
    const provider = xdProviderWithFullRouting() as ReturnType<typeof xdProviderWithFullRouting> & {
      routing: { codex: Record<string, unknown>; 'claude-code': Record<string, unknown> };
    };
    provider.routing.codex.wireProtocol = 'openai-chat';
    const { providers } = project({ providers: [provider] });
    const routing = providers[0].routing as Record<string, Record<string, unknown>>;
    expect(routing.codex).toEqual({ wireProtocol: 'openai-chat' });
    expect(routing.codex).not.toHaveProperty('upstream');
    expect(routing.codex).not.toHaveProperty('authStrategy');
  });

  it('保留 disabled:true 可用性门控，避免禁用 runtime 在控制端重新变成可选', () => {
    const provider = xdProviderWithFullRouting() as ReturnType<typeof xdProviderWithFullRouting> & {
      routing: { codex: Record<string, unknown>; 'claude-code': Record<string, unknown> };
    };
    provider.routing.codex.disabled = true;
    const { providers } = project({ providers: [provider] });
    const routing = providers[0].routing as Record<string, Record<string, unknown>>;

    expect(routing.codex).toEqual({ disabled: true });
    expect(routing['claude-code']).toEqual({});
    expect(connectedProvidersForAgent(providers as unknown as ProviderView[], 'codex')).toEqual([]);
    expect(
      connectedProvidersForAgent(providers as unknown as ProviderView[], 'claude-code'),
    ).toHaveLength(1);
    expect(JSON.stringify(routing)).not.toContain(XD_GATEWAY_BASE_URL);
  });

  it('models[agent] 原样透传（Fast 显隐数据源:per-provider supportsFastMode）', () => {
    const { providers } = project({ providers: [xdProviderWithFullRouting()] });
    const models = providers[0].models as Record<
      string,
      { id: string; supportsFastMode?: boolean }[]
    >;
    expect(models['claude-code'][0]).toMatchObject({
      id: 'claude-opus-4-8',
      supportsFastMode: true,
    });
  });

  it('保留模型显示 override 快照并过滤非布尔值', () => {
    const projected = project({
      providers: [xdProviderWithFullRouting()],
      modelVisibilityOverrides: {
        'claude-code:xd:claude-opus-4-8': false,
        'codex:xd:gpt-5.4': true,
        malformed: 'hidden',
      },
    });

    expect(projected.modelVisibilityOverrides).toEqual({
      'claude-code:xd:claude-opus-4-8': false,
      'codex:xd:gpt-5.4': true,
    });
  });

  it('provider 无 routing → 投影为 undefined（不报错）', () => {
    const { providers } = project({
      providers: [{ id: 'bare', name: 'Bare', connected: true, agents: ['claude-code'] }],
    });
    expect(providers[0].routing).toBeUndefined();
  });

  it('保留 provider 的其它显示字段（id / name / connected / agents 原样透传）', () => {
    const { providers } = project({ providers: [xdProviderWithFullRouting()] });
    expect(providers[0]).toMatchObject({
      id: 'xd',
      name: 'XD Gateway',
      connected: true,
      agents: ['claude-code', 'codex'],
    });
  });

  it('重命名 preset 在剥掉 upstream 前解析非敏感 logoKind', () => {
    const renamed = {
      ...xdProviderWithFullRouting(),
      id: 'my-renamed-kimi-provider',
      name: '团队模型服务',
      routing: {
        'claude-code': {
          upstream: 'https://api.moonshot.cn/v1',
          authStrategy: 'api-key',
          headerOverride: { authorization: 'secret' },
        },
      },
    };
    const { providers } = project({ providers: [renamed] });

    expect(providers[0].logoKind).toBe('moonshot');
    expect(providers[0].routing).toEqual({ 'claude-code': {} });
    expect(JSON.stringify(providers[0])).not.toContain('api.moonshot.cn');
    expect(JSON.stringify(providers[0])).not.toContain('secret');
  });

  it('新 logo kind 不发给独立更新的旧版 mobile，避免旧路径表索引 undefined', () => {
    const { providers } = project({
      providers: [
        {
          ...xdProviderWithFullRouting(),
          id: 'my-renamed-vercel-provider',
          routing: {
            codex: { upstream: 'https://ai-gateway.vercel.sh/v1' },
          },
        },
      ],
    });

    expect(providers[0]).not.toHaveProperty('logoKind');
    expect(providers[0].routing).toEqual({ codex: {} });
  });

  it('声明完整 logo 能力的当前控制端收到新 logo kind', () => {
    const { providers } = projectForCurrentController({
      providers: [
        {
          ...xdProviderWithFullRouting(),
          id: 'my-renamed-vercel-provider',
          routing: {
            codex: { upstream: 'https://ai-gateway.vercel.sh/v1' },
          },
        },
      ],
    });

    expect(providers[0].logoKind).toBe('vercel');
    expect(providers[0].routing).toEqual({ codex: {} });
  });

  it('混合品牌 routing 不产生 logoKind,也不透传伪造值', () => {
    const { providers } = project({
      providers: [
        {
          ...xdProviderWithFullRouting(),
          id: 'mixed-provider',
          logoKind: 'xai',
          routing: {
            codex: { upstream: 'https://api.openai.com/v1' },
            'claude-code': { upstream: 'https://api.anthropic.com/v1' },
          },
        },
      ],
    });

    expect(providers[0]).not.toHaveProperty('logoKind');
    expect(providers[0].routing).toEqual({ codex: {}, 'claude-code': {} });
  });

  it('非 maker:provider:list 通道 → 原样返回不改', () => {
    const other = { foo: 'bar', providers: [xdProviderWithFullRouting()] };
    expect(__testing.projectInvokeResultForTunnel('maker:set-model', other)).toBe(other);
  });

  it('result 非 { providers: [] } 形状 → 原样返回', () => {
    const weird = { notProviders: 1 };
    expect(__testing.projectInvokeResultForTunnel('maker:provider:list', weird)).toBe(weird);
  });
});
