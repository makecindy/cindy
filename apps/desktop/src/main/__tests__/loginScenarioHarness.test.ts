import { describe, expect, it } from 'vitest';

import { CindyAuthClient } from '@cindy/auth-client';
import { resolveLoginScenarioFetch } from '@cindy/auth-client/fixtures';

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
