/**
 * 2026-08-06 review P1：skills-hub 的 path 带用户/第三方 skill 身份
 * (`/api/skills-hub/skills/<name>`)。skillhubApiFetch 必须给 serverApiFetch 传不含身份的
 * logLabel 路由模板,否则 4xx/5xx 的 not_ok 日志会把 skill 名外泄进 serverApiClient scope。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ serverApiFetch: vi.fn() }));

vi.mock('../../serverApiClient', () => ({ serverApiFetch: mocks.serverApiFetch }));
vi.mock('../../clientEndpointsService', () => ({
  getClientEndpoint: () => 'https://skills.example.com',
}));
vi.mock('../../appCapabilities.js', () => ({ requireAppCapability: () => undefined }));

import { skillhubApiFetch } from '../hubApi';

describe('skillhubApiFetch', () => {
  beforeEach(() => mocks.serverApiFetch.mockReset());

  it('给 serverApiFetch 传 logLabel=/api/skills-hub（不外泄 skill 身份）', async () => {
    mocks.serverApiFetch.mockResolvedValueOnce({ ok: true });
    await skillhubApiFetch('/api/skills-hub/skills/secret-skill-name');
    const opts = mocks.serverApiFetch.mock.calls[0]?.[1] ?? {};
    expect(opts.logLabel).toBe('/api/skills-hub');
    // 不设 redactErrorDetails:SkillHub 依赖 ServerApiError.code 做业务分支,不能把 code 压成通用码。
    expect(opts.redactErrorDetails).toBeUndefined();
  });

  it('调用方显式传的 logLabel 优先', async () => {
    mocks.serverApiFetch.mockResolvedValueOnce({ ok: true });
    await skillhubApiFetch('/api/skills-hub/skills/x', { logLabel: '/api/skills-hub/skills' });
    expect(mocks.serverApiFetch.mock.calls[0]?.[1]?.logLabel).toBe('/api/skills-hub/skills');
  });
});
