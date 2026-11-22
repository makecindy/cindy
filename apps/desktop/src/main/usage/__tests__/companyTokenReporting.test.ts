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
  allowed: vi.fn(),
  subscribe: vi.fn(),
}));
vi.mock('../../analytics-settings-store.js', () => ({ isAnalyticsAllowed: ports.allowed }));
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
let settingsChanged: (allowed: boolean, explicitEnabled?: boolean) => void;
const subscribeSettings = (listener: typeof settingsChanged) => {
  settingsChanged = listener;
  return () => {};
};
beforeEach(() => {
  vi.resetAllMocks();
  ports.allowed.mockReturnValue(true);
  dir = mkdtempSync(path.join(os.tmpdir(), 'cindy-company-test-'));
  ports.getPath.mockReturnValue(dir);
  ports.getAuthState.mockReturnValue(state);
  ports.token.mockReturnValue('test');
  ports.subscribe.mockReturnValue(() => undefined);
  service = createCompanyTokenReporting(subscribeSettings);
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
    expect(startCompanyUsage()).toBeUndefined();
    settingsChanged(true, true);
    expect(ports.fetch).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual([]);
  },
);
it('keeps the policy until its 12-hour recheck and ignores unchanged identity notifications', async () => {
  service.dispose();
  vi.useFakeTimers();
  try {
    let finish!: (response: Response) => void;
    ports.fetch.mockReturnValueOnce(new Promise<Response>(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(Response.json(me(false)));
    service = createCompanyTokenReporting(subscribeSettings);
    service.refresh();
    await vi.advanceTimersByTimeAsync(1_000);
    finish(Response.json(me(true)));
    await vi.advanceTimersByTimeAsync(0);
    const onAuthChange = ports.subscribe.mock.lastCall![0];
    onAuthChange();
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000 - 60_000 - 1_000);
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

// Unit regression for discussion_r4654181708: the public service previously waited 12 hours
// after a single offline request. Existing delivery tests only retried via manual refresh.
// Fake time and synthetic responses verify recovery, durable withdrawal and batch idempotency.
it.each(['policy', 'withdrawal', 'batch'] as const)(
  'automatically retries a failed %s after five minutes and restores the normal cadence',
  async (failure) => {
    const { CompanyTokenQueue } = await import('../companyTokenQueue');
    service.dispose();
    vi.useFakeTimers();
    try {
      const file = path.join(dir, 'company-token-outbox.json');
      if (failure === 'batch') {
        new CompanyTokenQueue(file).add(
          { owner: JSON.stringify(['cn', org.orgId, org.id]), orgRevision: 2, memberRevision: 1 },
          [{ day: '2020-01-01', model: 'gpt-5', ...counts }],
        );
      }
      const failedRoute = { policy: '/api/me', withdrawal: '/participation', batch: '/batches' }[failure];
      const batches: string[] = [];
      let attempts = 0;
      let participating = true;
      ports.fetch.mockImplementation(async (url: string, options) => {
        if (url.endsWith('/batches')) batches.push(JSON.parse(options.body).batchId);
        if (url.endsWith(failedRoute) && ++attempts === 1) throw new Error('offline');
        if (url.endsWith('/api/me')) return Response.json({
          ...me(true), membership: { ...member, companyTokenReporting: { ...rule, participating } },
        });
        if (url.endsWith('/participation')) participating = JSON.parse(options.body).participating;
        return new Response(null, { status: 204 });
      });
      service = createCompanyTokenReporting(subscribeSettings);
      if (failure === 'withdrawal') {
        ports.allowed.mockReturnValue(false);
        settingsChanged(false, false);
      } else {
        service.refresh();
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      expect(companyExecutionReporting()?.available()).toBe(failure === 'batch');
      if (failure === 'withdrawal') expect(readdirSync(dir).some(name => name.startsWith('company-token-opt-out-'))).toBe(true);
      await vi.advanceTimersByTimeAsync(5 * 60_000 - 1);
      expect(attempts).toBe(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(attempts).toBe(2);
      expect(companyExecutionReporting()?.available()).toBe(failure !== 'withdrawal');
      if (failure === 'withdrawal') {
        expect(participating).toBe(false);
        expect(readdirSync(dir)).toEqual([]);
      }
      if (failure === 'batch') expect(batches).toEqual([batches[0], batches[0]]);
      const requests = ports.fetch.mock.calls.length;
      await vi.advanceTimersByTimeAsync(12 * 60 * 60_000 - 1);
      expect(ports.fetch).toHaveBeenCalledTimes(requests);
      await vi.advanceTimersByTimeAsync(1);
      expect(ports.fetch).toHaveBeenCalledTimes(requests + (failure === 'withdrawal' ? 0 : 1));
    } finally {
      service.dispose();
      vi.useRealTimers();
    }
  },
);

it('never schedules another request when an offline response arrives after disposal', async () => {
  service.dispose();
  vi.useFakeTimers();
  try {
    let fail!: (error: Error) => void;
    ports.fetch.mockReturnValue(new Promise((_resolve, reject) => { fail = reject; }));
    service = createCompanyTokenReporting(subscribeSettings);
    service.refresh();
    service.dispose();
    fail(new Error('offline'));
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(ports.fetch).toHaveBeenCalledTimes(1);
    expect(companyExecutionReporting()?.available()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    service.dispose();
    vi.useRealTimers();
  }
});

it('does not use the short retry cadence when the server denies company authorization', async () => {
  service.dispose();
  vi.useFakeTimers();
  try {
    ports.fetch.mockResolvedValue(new Response(null, { status: 403 }));
    service = createCompanyTokenReporting(subscribeSettings);
    service.refresh();
    await vi.advanceTimersByTimeAsync(12 * 60 * 60_000 - 1);
    expect(ports.fetch).toHaveBeenCalledTimes(1);
    expect(startCompanyUsage()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(ports.fetch).toHaveBeenCalledTimes(2);
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
  ports.allowed.mockReturnValue(false);
  settingsChanged(false, false);
  expect(companyExecutionReporting()?.available()).toBe(false);
  record([{ model: 'gpt-5', ...counts }]);
  expect(existsSync(file)).toBe(false);
  await vi.waitFor(() => expect(ports.fetch.mock.calls.filter(([url]) => url.endsWith('/participation'))).toHaveLength(1));
  expect(
    ports.fetch.mock.calls.map((call) => call[0]).filter((url) => !url.endsWith('/api/me')),
  ).toEqual(['https://tenant.invalid/api/orgs/org1/company-token-reporting/participation']);
  service.dispose();
  service = createCompanyTokenReporting(subscribeSettings);
  service.refresh();
  await vi.waitFor(() =>
    expect(
      ports.fetch.mock.calls.filter((call) => call[0].endsWith('/participation')),
    ).toHaveLength(2),
  );
  expect(startCompanyUsage()).toBeUndefined();
});
it('leaves a previous member withdrawal in place until an explicit enable, then only records new turns', async () => {
  let participating = false;
  const changes: boolean[] = [];
  ports.fetch.mockImplementation(async (url, options) => {
    if (url.endsWith('/api/me')) return Response.json({
      ...me(true), membership: { ...member, companyTokenReporting: { ...rule, participating } },
    });
    if (url.endsWith('/participation')) {
      participating = JSON.parse(options.body).participating;
      changes.push(participating);
      return new Response(null, { status: 204 });
    }
    throw new Error('unexpected delivery');
  });
  service.dispose();
  ports.allowed.mockReturnValue(false);
  service = createCompanyTokenReporting(subscribeSettings);
  service.refresh();
  expect(ports.fetch).not.toHaveBeenCalled();
  ports.allowed.mockReturnValue(true);
  settingsChanged(true);
  await vi.waitFor(() => expect(ports.fetch).toHaveBeenCalledTimes(1));
  expect(startCompanyUsage()).toBeUndefined();
  expect(changes).toEqual([]);
  settingsChanged(true, true);
  await vi.waitFor(() => expect(startCompanyUsage()).toBeTypeOf('function'));
  expect(changes).toEqual([true]);
  const prior = startCompanyUsage()!;
  ports.allowed.mockReturnValue(false);
  settingsChanged(false, false);
  prior([{ model: 'gpt-5', ...counts }]);
  expect(existsSync(path.join(dir, 'company-token-outbox.json'))).toBe(false);
  expect(companyExecutionReporting()?.challenge('nonce')).toBeNull();
  await vi.waitFor(() => expect(changes).toEqual([true, false]));
});

it('cancels an in-flight report and discards its pending batch when the master switch closes', async () => {
  const { CompanyTokenQueue } = await import('../companyTokenQueue');
  const file = path.join(dir, 'company-token-outbox.json');
  const scope = { owner: JSON.stringify(['cn', org.orgId, org.id]), orgRevision: 2, memberRevision: 1 };
  new CompanyTokenQueue(file).add(scope, [{ day: '2020-01-01', model: 'gpt-5', ...counts }]);
  let sent: AbortSignal | undefined;
  ports.fetch.mockImplementation(async (url, options) => {
    if (url.endsWith('/api/me')) return Response.json(me(true));
    if (url.endsWith('/participation')) return new Response(null, { status: 204 });
    sent = options.signal;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  service.refresh();
  await vi.waitFor(() => expect(sent).toBeDefined());
  ports.allowed.mockReturnValue(false);
  settingsChanged(false, false);
  expect(sent?.aborted).toBe(true);
  expect(existsSync(file)).toBe(false);
  await vi.waitFor(() => expect(ports.fetch.mock.calls.some(([url]) => url.endsWith('/participation'))).toBe(true));
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
  expect(companyExecutionReporting()?.available()).toBe(true);
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
