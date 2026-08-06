import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CindyAuthClient } from '@cindy/auth-client';
import { resolveLoginScenarioFetch } from '@cindy/auth-client/fixtures';

/**
 * 桌面端登录 scenario harness 接线测试(implementation-plan Step 0 WHAT4 / SC-1)。
 *
 * 分两层:
 * 1. 注入点静态断言(authManager.ts 依赖重、不宜整模块加载,沿用本目录
 *    authLoginFlowReset.test.ts 的读源码断言模式):guard 形态与「真实 client +
 *    scenario fetch 构造参数注入」形态不许漂移。
 * 2. guard 行为断言(fixtures 包纯函数):app.isPackaged(devModeActive=false)
 *    下 harness 全部失效——production-mode 断言。
 */
const authManagerSource = readFileSync(
  resolve(process.cwd(), 'src/main/authManager.ts'),
  'utf8',
);
const viteMainConfigSource = readFileSync(
  resolve(process.cwd(), 'vite.main.config.ts'),
  'utf8',
);

describe('authManager 注入点(静态源码断言)', () => {
  it('经静态 import 使用 fixtures(main 禁运行时动态 import)', () => {
    expect(authManagerSource).toContain(
      "import { resolveLoginScenarioFetch } from '@cindy/auth-client/fixtures'",
    );
    expect(authManagerSource).not.toContain("import('@cindy/auth-client/fixtures')");
  });

  it('guard 写死为 !app.isPackaged + XDT_LOGIN_SCENARIO(附录 A 值域 env)', () => {
    expect(authManagerSource).toContain('devModeActive: !app.isPackaged');
    expect(authManagerSource).toContain('scenario: process.env.XDT_LOGIN_SCENARIO');
  });

  it('注入形态 = 真实 CindyAuthClient + fetch 构造参数(scenarioFetch ?? 真 fetch)', () => {
    expect(authManagerSource).toContain(
      'fetch: scenarioFetch ?? (async (input, init) => net.fetch(input, init as RequestInit))',
    );
    // 不替换 client、不 fake 方法:注入点仍是唯一的 new CindyAuthClient 构造
    expect(authManagerSource.match(/new CindyAuthClient\(/g)).toHaveLength(1);
  });

  it('vite.main.config 挂了生产 stub alias(build-time 排除双保险)', () => {
    expect(viteMainConfigSource).toContain("mode === 'production'");
    expect(viteMainConfigSource).toContain("find: '@cindy/auth-client/fixtures'");
    expect(viteMainConfigSource).toContain('loginScenarios.production-stub.ts');
  });

  it('vite.main.config 保留显式空 Team ID,不让 .env 旧值重新启用 Touch ID', () => {
    expect(viteMainConfigSource).toContain(
      "Object.prototype.hasOwnProperty.call(process.env, key)",
    );
    expect(viteMainConfigSource).toContain(
      "readMainEnvPreservingEmpty('CINDY_WEBAUTHN_APPLE_TEAM_ID').trim()",
    );
  });
});

describe('guard 行为(production-mode 断言)', () => {
  it('app.isPackaged(devModeActive=false)→ 即使 env 设置了 scenario 也恒 null', () => {
    expect(
      resolveLoginScenarioFetch({
        devModeActive: false,
        scenario: 'providers:both',
        region: 'cn',
      }),
    ).toBeNull();
  });

  it('dev + scenario → 真实 client 全真路径可走通(zod schema 全真)', async () => {
    const scenarioFetch = resolveLoginScenarioFetch({
      devModeActive: true,
      scenario: 'providers:cn-social',
      region: 'cn',
    });
    expect(scenarioFetch).toBeTypeOf('function');
    const client = new CindyAuthClient({
      baseUrl: 'https://auth.scenario.invalid',
      region: 'cn',
      deviceId: 'harness-device',
      clientType: 'desktop',
      fetch: scenarioFetch!,
    });
    const providers = await client.getProviders();
    expect(providers.social).toEqual(['apple']);
    expect(providers.region).toBe('cn');
  });
});
