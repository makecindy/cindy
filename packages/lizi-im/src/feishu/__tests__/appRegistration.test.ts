import { describe, expect, it, vi } from 'vitest';

import { FEISHU_ACCOUNTS_BASE_URL, requestAppRegistration } from '../appRegistration.js';

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
});
