import { describe, expect, it, vi } from 'vitest';

import {
  FEISHU_ACCOUNTS_BASE_URL,
  pollAppRegistration,
  requestAppRegistration,
} from '../appRegistration.js';

describe('app registration service routing', () => {
  it('bootstraps on Feishu while using the selected verification host', async () => {
    const post = vi.fn(async () => ({
      status: 200,
      body: {
        device_code: 'device-code',
        user_code: 'user-code',
        expires_in: 300,
        interval: 5,
      },
    }));

    const result = await requestAppRegistration(post, 'lark');

    expect(post).toHaveBeenCalledWith(
      `${FEISHU_ACCOUNTS_BASE_URL}/oauth/v1/app/registration`,
      expect.any(URLSearchParams),
    );
    expect(result.verificationUrl).toContain('open.larksuite.com');
  });

  it('preserves tenant brand discovery on authorization-pending responses', async () => {
    const post = vi.fn(async () => ({
      status: 400,
      body: {
        error: 'authorization_pending',
        user_info: { tenant_brand: 'lark' },
      },
    }));

    await expect(
      pollAppRegistration(post, 'feishu', 'device-code', 5),
    ).resolves.toEqual({
      status: 'pending',
      tenantBrand: 'lark',
    });
  });

  it('keeps polling when a successful response has no complete credentials yet', async () => {
    const post = vi.fn(async () => ({
      status: 200,
      body: {
        user_info: { tenant_brand: 'lark' },
      },
    }));

    await expect(
      pollAppRegistration(post, 'feishu', 'device-code', 5),
    ).resolves.toEqual({
      status: 'pending',
      tenantBrand: 'lark',
    });
  });
});
