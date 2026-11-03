import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }));
vi.mock('electron', () => ({ net: { fetch: mocks.fetch } }));
vi.mock('../../authManager', () => ({ getAccessToken: () => 'fixture-token', refresh: async () => false, invalidateSession: vi.fn() }));
vi.mock('../../logger', () => ({ createLogger: () => ({ error: mocks.error, warn: mocks.warn, debug: mocks.debug }) }));
vi.mock('../../i18n.js', () => ({ getResolvedMainLocale: () => 'en' }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => 'https://models.example.test' }));
import { readOrganizationAccountUsage } from '../organizationAccountUsage';
beforeEach(() => vi.clearAllMocks());
describe('quota through real server API client', () => {
  it('preserves the explicit Nova unsupported signal through redaction', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 501, json: async () => ({ error: { code: 'MODEL_ACCESS_QUOTA_NOT_SUPPORTED', message: 'private-upstream-detail' } }) });
    expect(await readOrganizationAccountUsage()).toBeUndefined();
    expect(JSON.stringify([mocks.error.mock.calls, mocks.warn.mock.calls, mocks.debug.mock.calls])).not.toContain('private-upstream-detail');
  });
  it('does not allow an unrelated 501 to activate legacy credentials', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 501, json: async () => ({ error: { code: 'OTHER_UNSUPPORTED', message: 'private-upstream-detail' } }) });
    expect(await readOrganizationAccountUsage()).toBeNull();
  });
  it('retains old-server 404 compatibility through redaction', async () => {
    mocks.fetch.mockResolvedValue({ ok: false, status: 404, json: async () => ({ error: { code: 'NOT_FOUND' } }) });
    expect(await readOrganizationAccountUsage()).toBeUndefined();
  });
});
