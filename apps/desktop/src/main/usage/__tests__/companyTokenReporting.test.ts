import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCompanyTokenReporting } from '../companyTokenReporting.desktop';
import { startCompanyUsage } from '../companyTokenFacts';

const ports = vi.hoisted(() => ({
  fetch: vi.fn(),
  getPath: vi.fn(),
  getAuthState: vi.fn(),
  token: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: ports.getPath }, net: { fetch: ports.fetch } }));
vi.mock('../../authManager.js', () => ({
  getActiveAuthRealm: () => 'cn',
  getAuthState: ports.getAuthState,
  getAccessToken: ports.token,
  onAuthStateChange: () => () => undefined,
}));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpointForRealm: () => 'https://tenant.invalid',
}));
vi.mock('../../maker-host/active-catalog.js', () => ({
  getActiveCatalog: () => ({ providers: [] }),
}));
vi.mock('../../model-access/effectiveEndpoint.js', () => ({ effectiveXdGatewayBaseUrl: () => '' }));
const org = { id: 'member1', orgId: 'org1', membershipKind: 'org' };
const state = {
  user: org,
  isAuthenticated: true,
  mode: 'cloud',
  canEnterApp: true,
  ownerGeneration: 1,
  deviceId: 'device1',
};
const member = {
  id: org.id,
  orgId: org.orgId,
  kind: 'org',
  role: 'member',
  displayName: 'Employee',
  email: null,
  orgName: 'Company',
};
const rule = { models: ['gpt-5'], memberRevision: 1, orgRevision: 2, participating: true };
const me = (enabled: boolean) => ({
  membership: { ...member, ...(enabled && { companyTokenReporting: rule }) },
  passportId: 'p',
  identities: [],
});
const counts = { input: 11, output: 2, cacheRead: 1, cacheWrite: 3 };
let dir: string;
let service: ReturnType<typeof createCompanyTokenReporting>;
beforeEach(() => {
  vi.resetAllMocks();
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-company-test-'));
  ports.getPath.mockReturnValue(dir);
  ports.getAuthState.mockReturnValue(state);
  ports.token.mockReturnValue('test');
  service = createCompanyTokenReporting();
});
afterEach(() => {
  service.dispose();
  rmSync(dir, { recursive: true, force: true });
});
it.each([
  { ...state, mode: 'local' },
  { ...state, isAuthenticated: false },
  { ...state, user: { ...org, membershipKind: 'personal' } },
])(
  'does not expose, collect or call services without an active company identity',
  async (status) => {
    ports.getAuthState.mockReturnValue(status);
    service.refresh();
    expect(service.view()).toBeNull();
    expect(startCompanyUsage()).toBeUndefined();
    await expect(service.set(true, 1)).rejects.toThrow();
    expect(ports.fetch).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  },
);
it('uses only the account endpoint until the company enables reporting; stops and purges immediately on opt-out', async () => {
  let enabled = false;
  ports.fetch.mockImplementation(async (url: string) => {
    if (url.endsWith('/api/me')) return Response.json(me(enabled));
    throw new Error('offline');
  });
  service.refresh();
  await vi.waitFor(() => expect(ports.fetch).toHaveBeenCalledTimes(1));
  expect(service.view()).toBeNull();
  expect(startCompanyUsage()).toBeUndefined();
  enabled = true;
  service.refresh();
  await vi.waitFor(() => expect(service.view()?.participating).toBe(true));
  expect(startCompanyUsage()).toBeUndefined();
  service.noted(1);
  const record = startCompanyUsage()!;
  record('gpt-5', counts);
  const file = path.join(dir, 'company-token-outbox.json');
  expect(existsSync(file)).toBe(true);
  const change = service.set(false, 1);
  record('gpt-5', counts);
  expect(existsSync(file)).toBe(false);
  await expect(change).rejects.toThrow('offline');
  expect(
    ports.fetch.mock.calls.map((call) => call[0]).filter((url) => !url.endsWith('/api/me')),
  ).toEqual(['https://tenant.invalid/api/orgs/org1/company-token-reporting/participation']);
  service.dispose();
  service = createCompanyTokenReporting();
  service.refresh();
  await vi.waitFor(() =>
    expect(
      ports.fetch.mock.calls.filter((call) => call[0].endsWith('/participation')),
    ).toHaveLength(2),
  );
  expect(startCompanyUsage()).toBeUndefined();
});
it('drops an old in-flight policy response after logout and never reports a turn across identities', async () => {
  let finish!: (r: Response) => void;
  ports.fetch.mockReturnValue(
    new Promise<Response>((resolve) => {
      finish = resolve;
    }),
  );
  service.refresh();
  ports.getAuthState.mockReturnValue({
    ...state,
    isAuthenticated: false,
    user: null,
    ownerGeneration: 2,
  });
  service.refresh();
  finish(Response.json(me(true)));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(service.view()).toBeNull();
  expect(startCompanyUsage()).toBeUndefined();
  expect(readdirSync(dir)).toEqual([]);
});

it('accepts proven subscription and BYOK routes and rejects explicit or disguised Gateway routes', async () => {
  const { directCompanyTokenRoute } = await import('../companyTokenRoute');
  const gateway = 'https://gateway.example.test/api';
  const direct = {
    upstream: 'https://provider.example.test/v1',
    authStrategy: 'api-key-header' as const,
  };
  expect(directCompanyTokenRoute('byok', direct, gateway)).toBe(true);
  expect(
    directCompanyTokenRoute(
      'subscription',
      { ...direct, authStrategy: 'oauth-passthrough' },
      gateway,
    ),
  ).toBe(true);
  expect(directCompanyTokenRoute('xd', direct, gateway)).toBe(false);
  expect(
    directCompanyTokenRoute(
      'custom',
      { ...direct, upstream: 'https://gateway.example.test/model' },
      gateway,
    ),
  ).toBe(false);
  expect(
    directCompanyTokenRoute('custom', { ...direct, authStrategy: 'gateway-key' }, gateway),
  ).toBe(false);
  expect(directCompanyTokenRoute('unresolved', undefined, gateway)).toBe(false);
});
