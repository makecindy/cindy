import { describe, expect, it } from 'vitest';

import { CindyAuthClient } from '@cindy/auth-client';
import { resolveLoginScenarioFetch } from '@cindy/auth-client/fixtures';

describe('guard 行为(production-mode 断言)', () => {
  it('非 __DEV__(devModeActive=false)→ 即使 env 设置了 scenario 也恒 null', () => {
    expect(
      resolveLoginScenarioFetch({
        devModeActive: false,
        scenario: 'outcome:select-account',
        region: 'cn',
      }),
    ).toBeNull();
  });

  it('dev + scenario → 真实 mobile client 全真路径可走通', async () => {
    const scenarioFetch = resolveLoginScenarioFetch({
      devModeActive: true,
      scenario: 'outcome:binding-phone',
      region: 'cn',
    });
    expect(scenarioFetch).toBeTypeOf('function');
    const client = new CindyAuthClient({
      baseUrl: 'https://auth.scenario.invalid',
      region: 'cn',
      deviceId: 'harness-device',
      clientType: 'mobile',
      fetch: scenarioFetch!,
    });
    const outcome = await client.verifyCode('phone', '13800000000', '123456');
    expect(outcome).toMatchObject({ status: 'binding_required', bindType: 'phone' });
  });
});
