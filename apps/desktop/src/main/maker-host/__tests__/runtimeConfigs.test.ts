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

    const { buildDesktopClaudeRuntimeConfig, desktopCodexRuntimeConfig } = await import('../runtime-configs.js');

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
});
