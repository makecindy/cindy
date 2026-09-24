import { beforeEach, describe, expect, it, vi } from 'vitest';

let memorySettings = {
  maker: true,
  claudeCode: false,
  codex: false,
  pi: false,
};

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/tmp/xdt-maker-test-app',
    getPath: (name: string) => {
      if (name !== 'userData') throw new Error(`unexpected path: ${name}`);
      return '/tmp/xdt-maker-test-user-data';
    },
  },
}));

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    chmodSync: vi.fn(),
    default: {
      ...actual,
      existsSync: vi.fn(() => true),
      chmodSync: vi.fn(),
    },
  };
});

// runtime-configs 经 effectiveXdGatewayBaseUrl 读 model-access 下发的 endpoint;
// 本测试不断言端点,mock 成 fixture 值只为隔离 credentialsStore 的文件 IO。
vi.mock('../../model-access/effectiveEndpoint.js', async () => {
  const { TEST_XD_GATEWAY_BASE_URL } = await import('../../../test/vitest/clientEndpointsFixture');
  return { effectiveXdGatewayBaseUrl: () => TEST_XD_GATEWAY_BASE_URL };
});

describe('runtime-configs', () => {
  beforeEach(() => {
    vi.resetModules();
    memorySettings = {
      maker: true,
      claudeCode: false,
      codex: false,
      pi: false,
    };
  });

  it('propagates persisted Maker Memory enablement into agent runtime configs', async () => {
    vi.doMock('../memory-settings-store.js', () => ({
      readMemorySettings: () => memorySettings,
    }));

    const { buildDesktopClaudeRuntimeConfig, desktopCodexRuntimeConfig } = await import(
      '../runtime-configs.js'
    );

    const claudeConfig = buildDesktopClaudeRuntimeConfig(() => 'http://127.0.0.1:1234');

    expect(claudeConfig.memoryEnabled).toBe(false);
    expect(claudeConfig.makerMemoryEnabled).toBe(true);
    expect(desktopCodexRuntimeConfig.memoryEnabled).toBe(false);
    expect(desktopCodexRuntimeConfig.makerMemoryEnabled).toBe(true);

    memorySettings = {
      maker: false,
      claudeCode: true,
      codex: true,
      pi: true,
    };

    expect(claudeConfig.memoryEnabled).toBe(true);
    expect(claudeConfig.makerMemoryEnabled).toBe(false);
    expect(desktopCodexRuntimeConfig.memoryEnabled).toBe(true);
    expect(desktopCodexRuntimeConfig.makerMemoryEnabled).toBe(false);
  });

  it('Claude 订阅会话只注入 Anthropic 一方的子代理覆写;网关会话的覆写语义不变', async () => {
    let saved = 'chatgpt/gpt-5.5';
    vi.doMock('../memory-settings-store.js', () => ({
      readMemorySettings: () => memorySettings,
    }));
    vi.doMock('../subagent-model-settings-store.js', () => ({
      readSubagentModelSettings: () => ({ claudeCode: saved }),
    }));
    vi.doMock('../model-disable-store.js', () => ({ readModelDisableOverrides: () => ({}) }));
    const { buildDesktopClaudeRuntimeConfig } = await import('../runtime-configs.js');
    const config = buildDesktopClaudeRuntimeConfig(() => 'http://127.0.0.1:1234');
    const route = config.subagentModelForRoute!;

    // 订阅会话:CLI 直连 Anthropic,订阅桥 / 用户来源的模型用不了。
    expect(route('anthropic', 'oauth-bearer')).toBeUndefined();
    expect(route(null, 'oauth-bearer')).toBeUndefined();
    saved = 'glm-5';
    expect(route(null, 'oauth-bearer')).toBeUndefined();
    // 网关会话:订阅前缀由 proxy 按请求路由,照旧注入。
    saved = 'chatgpt/gpt-5.5';
    expect(route('xd', 'gateway-key')).toBe('chatgpt/gpt-5.5');
  });

  it('places generic Cindy-side Skill precedence in Claude and Codex only', async () => {
    vi.doMock('../memory-settings-store.js', () => ({
      readMemorySettings: () => memorySettings,
    }));

    const { buildDesktopClaudeRuntimeConfig, desktopCodexRuntimeConfig } = await import(
      '../runtime-configs.js'
    );
    const claudeConfig = buildDesktopClaudeRuntimeConfig(() => 'http://127.0.0.1:1234');
    const prompts = [claudeConfig.systemPrompt, desktopCodexRuntimeConfig.systemPrompt];

    for (const prompt of prompts) {
      expect(prompt).toContain('## Skill source precedence');
      expect(prompt).toMatch(
        /Cindy surfaces Skills from its own managed, user, and project\s+sources/u,
      );
      expect(prompt).toContain('Explicitly selecting the downstream Skill does not waive');
      // 来源判定必须落在可观察的清单标注上，并且无标注时 fail-closed 回落到
      // 「先跑 Cindy 侧 Skill」，否则这条规则对模型不可执行 (#1650 review)。
      expect(prompt).toMatch(/available-Skills listing already labels each Skill/u);
      expect(prompt).toMatch(
        /no usable source\s+label, treat the Skill as downstream and still run the applicable Cindy-side Skill first/u,
      );
      // 产品侧只表达来源级规则：不得出现具体 selector、Skill 名或本机路径。
      expect(prompt).not.toMatch(/\$[\w:-]+|\/(?:Users|home)\/|[A-Z]:\\/u);
    }
  });

  it('asks Claude and Codex to write user-facing plans in plain language', async () => {
    vi.doMock('../memory-settings-store.js', () => ({
      readMemorySettings: () => memorySettings,
    }));

    const { buildDesktopClaudeRuntimeConfig, desktopCodexRuntimeConfig } = await import(
      '../runtime-configs.js'
    );
    const claudeConfig = buildDesktopClaudeRuntimeConfig(() => 'http://127.0.0.1:1234');

    for (const prompt of [claudeConfig.systemPrompt, desktopCodexRuntimeConfig.systemPrompt]) {
      expect(prompt).toContain('## User-facing plans');
      expect(prompt).toContain('Write for a general user, not as internal engineering notes.');
      expect(prompt).toContain('Name the real action and visible result instead.');
    }
  });
});

it('never treats a retired independent Claude account as a connected subscription for spawn flags', async () => {
  vi.resetModules();
  const readBuiltin = vi.fn(() => true);
  vi.doMock('../active-catalog.js', () => ({ getActiveCatalog: () => ({ providers: [
    { id: 'claude-work', auth: { method: 'oauth', native: 'claude' } },
  ] }) }));
  vi.doMock('../claude-native-auth.js', () => ({ hasClaudeNativeLogin: readBuiltin }));
  try {
    const { buildDesktopClaudeRuntimeConfig } = await import('../runtime-configs.js');
    const flags = buildDesktopClaudeRuntimeConfig(() => 'http://localhost').behaviorFlags;
    if (typeof flags !== 'function') throw new Error('expected spawn flags');
    expect(flags({ credentialMode: 'provider-oauth', sessionProviderId: 'claude-work' } as never))
      .toMatchObject({ CLAUDE_CODE_ATTRIBUTION_HEADER: '0', ENABLE_TOOL_SEARCH: 'auto' });
    // 独立账号不借用本机 Claude Code 登录的连接态。
    expect(readBuiltin).not.toHaveBeenCalled();
    expect(flags({ credentialMode: 'oauth-bearer', sessionProviderId: 'anthropic' } as never))
      .toMatchObject({ CLAUDE_CODE_ATTRIBUTION_HEADER: '1', ENABLE_TOOL_SEARCH: 'auto' });
    expect(readBuiltin).toHaveBeenCalledTimes(1);
  } finally {
    vi.doUnmock('../active-catalog.js');
    vi.doUnmock('../claude-native-auth.js');
    vi.resetModules();
  }
});
