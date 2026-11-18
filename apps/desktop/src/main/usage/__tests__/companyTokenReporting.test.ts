import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCompanyTokenReporting } from '../companyTokenReporting.desktop';
import { companyExecutionReporting, startCompanyUsage } from '../companyTokenFacts';

const ports = vi.hoisted(() => ({
  fetch: vi.fn(),
  getPath: vi.fn(),
  getAuthState: vi.fn(),
  token: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('electron', () => ({ app: { getPath: ports.getPath }, net: { fetch: ports.fetch } }));
vi.mock('../../authManager.js', () => ({
  getActiveAuthRealm: () => 'cn',
  getAuthState: ports.getAuthState,
  getAccessToken: ports.token,
  onAuthStateChange: ports.subscribe,
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
  ports.subscribe.mockReturnValue(() => undefined);
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
it('keeps the policy until its 12-hour recheck and ignores unchanged identity notifications', async () => {
  service.dispose();
  vi.useFakeTimers();
  try {
    ports.fetch.mockResolvedValueOnce(Response.json(me(true))).mockResolvedValueOnce(Response.json(me(false)));
    service = createCompanyTokenReporting();
    service.refresh();
    await vi.advanceTimersByTimeAsync(0);
    const onAuthChange = ports.subscribe.mock.lastCall![0];
    onAuthChange();
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000 - 60_000);
    expect(ports.fetch).toHaveBeenCalledTimes(1);
    expect(startCompanyUsage()).toBeTypeOf('function');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ports.fetch).toHaveBeenCalledTimes(2);
    expect(startCompanyUsage()).toBeUndefined();
  } finally {
    service.dispose();
    vi.useRealTimers();
  }
});

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
  await vi.waitFor(() => expect(startCompanyUsage()).toBeTypeOf('function'));
  expect(companyExecutionReporting()?.available()).toBe(true);
  expect(companyExecutionReporting()?.challenge('nonce')).toMatchObject({ nonce: 'nonce' });
  const record = startCompanyUsage()!;
  record([{ model: 'gpt-5', ...counts }]);
  const file = path.join(dir, 'company-token-outbox.json');
  expect(existsSync(file)).toBe(true);
  const change = service.set(false, 1);
  expect(companyExecutionReporting()?.available()).toBe(false);
  record([{ model: 'gpt-5', ...counts }]);
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

it('retains valid collection and the same pending batch when delivery fails', async () => {
  const { CompanyTokenQueue } = await import('../companyTokenQueue');
  const file = path.join(dir, 'company-token-outbox.json');
  const scope = { owner: JSON.stringify(['cn', org.orgId, org.id]), orgRevision: 2, memberRevision: 1 };
  new CompanyTokenQueue(file).add(scope, [{ day: '2020-01-01', model: 'gpt-5', ...counts }]);
  const batches: string[] = [];
  ports.fetch.mockImplementation(async (url, options) => {
    if (url.endsWith('/api/me')) return Response.json(me(true));
    batches.push(JSON.parse(options.body).batchId);
    return new Response(null, { status: batches.length === 1 ? 503 : 200 });
  });
  service.refresh();
  await vi.waitFor(() => expect(batches).toHaveLength(1));
  expect(service.view()?.participating).toBe(true);
  startCompanyUsage()!([{ model: 'gpt-5', ...counts }]);
  service.refresh();
  await vi.waitFor(() => expect(batches).toEqual([batches[0], batches[0]]));
});

it('reports only confirmed Pi root requests even when a Gateway child used the same model', async () => {
  const { recordCompanyPiRoots } = await import('../companyPiReceipts');
  const record = vi.fn();
  const request = { model: 'gpt-5', inputTokens: 12, outputTokens: 7 };
  recordCompanyPiRoots(record, ['pi:1', 'pi:2', 'pi:1', 'pi-child:task:1', 'pi-unattributed:3', undefined]
    .map(id => ({ id, ...request })));
  const sample = { model: 'gpt-5', input: 12, output: 7, cacheRead: 0, cacheWrite: 0 };
  expect(record.mock.calls).toEqual([[[sample, sample]]]);
});

it('coalesces remote renewals and reauthorizes after midnight or a long idle period', async () => {
  const { createCompanyReportingRenewal } = await import('../../remote-agent/controller/companyReportingRenewal');
  const { installExecutionReporting } = await import('../companyTokenFacts');
  const issue = vi.fn().mockResolvedValue('grant');
  installExecutionReporting({ available: () => true, issue, challenge: () => null,
    redeem: async () => undefined, direct: () => false });
  const invoke = vi.fn().mockImplementation(async ([request]) => request.op === 'company-reporting-challenge'
    ? { nonce: '0'.repeat(36), recipient: 'a'.repeat(64) } : { authorized: true });
  const renew = createCompanyReportingRenewal(invoke);
  const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-18T23:59:50Z'));
  try {
    await Promise.all([renew('run', () => true), renew('run', () => true)]);
    await renew('run', () => true);
    expect(issue).toHaveBeenCalledTimes(1);
    now.mockReturnValue(Date.parse('2026-11-19T00:00:01Z'));
    await renew('run', () => true);
    now.mockReturnValue(Date.parse('2026-11-19T01:30:00Z'));
    await renew('run', () => true);
    expect(issue).toHaveBeenCalledTimes(3);
  } finally {
    now.mockRestore();
    installExecutionReporting(undefined);
  }
});

it('keeps one slow handshake in flight, then backs off failed sends for 30 seconds', async () => {
  const { createCompanyReportingRenewal } = await import('../../remote-agent/controller/companyReportingRenewal');
  const { installExecutionReporting } = await import('../companyTokenFacts');
  installExecutionReporting({ available: () => true, direct: () => true, challenge: () => null,
    issue: async () => null, redeem: async () => undefined });
  let finish!: () => void;
  const invoke = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = () => resolve(null); }))
    .mockResolvedValue(null);
  const now = vi.spyOn(Date, 'now').mockReturnValue(0);
  try {
    const renew = createCompanyReportingRenewal(invoke);
    const first = renew('run', () => true);
    now.mockReturnValue(40_000);
    const second = renew('run', () => true);
    expect(invoke).toHaveBeenCalledTimes(1);
    finish();
    await Promise.all([first, second]);
    for (let i = 0; i < 10; i++) await renew('run', () => true);
    expect(invoke).toHaveBeenCalledTimes(1);
    now.mockReturnValue(70_000);
    await renew('run', () => true);
    expect(invoke).toHaveBeenCalledTimes(2);
  } finally {
    now.mockRestore();
    installExecutionReporting(undefined);
  }
});
