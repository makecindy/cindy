import { beforeEach, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { PluginUsageService } from '../service';
import type { DbClient } from '../../localDb/client/DbClient';
import { runPluginUsageTransaction } from '../../localDb/worker/opHandlers/pluginUsageTx';
import type { PluginUsageIdentity, PluginUsageReportTarget } from '../../../shared/pluginUsage';
import { createPluginUsageReporting } from '../reporting';
vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' } }));

const state = vi.hoisted(() => ({
  allowed: true,
  local: false,
  owner: 'owner',
  root: 'https://one/',
  token: 'test-token',
  report: vi.fn(),
}));
vi.mock('../../authManager', () => ({
  getActiveAuthRealm: () => 'global',
  getAccessToken: () => state.token,
  getCurrentUserId: () => state.owner,
  isLocalMode: () => state.local,
}));
vi.mock('../../analytics-settings-store', () => ({ isAnalyticsAllowed: () => state.allowed }));
vi.mock('../../clientEndpointsService', () => ({ getClientEndpoint: () => state.root }));
vi.mock('../../plugin-market/api', () => ({
  PluginMarketApi: class {
    reportUsageBuckets = state.report;
  },
}));

const identity: PluginUsageIdentity = {
  ghostId: 'plugin',
  displayName: 'Official',
  revision: 'rev',
  sourceKind: 'server',
  stableKey: 'source',
  pluginId: 'id',
  organizationId: null,
  sourceKey: null,
  serverRoot: 'https://one',
  verifiedServerRoot: 'https://one',
  reportingScope: 'public',
  version: '1',
  releaseId: 'release',
};
beforeEach(() => {
  Object.assign(state, {
    allowed: true,
    local: false,
    owner: 'owner',
    root: 'https://one/',
    token: 'test-token',
  });
  state.report.mockReset();
});

it('requires verified distribution, never labels or custom public flags', () => {
  const r = createPluginUsageReporting('owner');
  expect(r.target({ ...identity, reportingScope: 'personal' })).toBeNull();
  expect(r.target(identity)).toMatchObject({ serverRoot: 'https://one', ownerId: 'owner' });
  for (const change of [
    { sourceKind: 'manual' as const },
    { sourceKind: 'git-market' as const },
    { sourceKind: 'local-market' as const },
    { verifiedServerRoot: undefined },
    { releaseId: null },
    { reportingScope: 'organization' as const },
  ]) {
    expect(r.target({ ...identity, ...change })).toBeNull();
  }
  expect(
    r.target({ ...identity, reportingScope: 'organization', organizationId: 'org' }),
  ).not.toBeNull();
});

it.each([{ allowed: false }, { local: true }, { owner: 'other' }, { root: 'https://two' }])(
  'blocks a frozen target when context changes: %o',
  (change) => {
    const r = createPluginUsageReporting('owner');
    const target = r.target(identity)!;
    Object.assign(state, change);
    expect(r.scope()).not.toBe(JSON.stringify(['global', target.serverRoot]));
    expect(r.target(identity)).toBeNull();
  },
);

it('rechecks the root at request serialization and never falls back to another current account token', async () => {
  const r = createPluginUsageReporting('owner');
  const target = r.target(identity)!;
  state.report.mockImplementation(async (_plugin, _events, context) => {
    expect(context.token).toBe('test-token');
    state.root = 'https://other';
    context.assertCurrent();
  });
  await expect(r.send(target, [], new AbortController().signal, vi.fn())).rejects.toThrow('source changed');
});

it('rejects a queued personal target before contacting the market API', async () => {
  const reporting = createPluginUsageReporting('owner');
  const stale = { ...reporting.target(identity)!, scope: 'personal' } as unknown as PluginUsageReportTarget;
  await expect(reporting.send(stale, [], new AbortController().signal, vi.fn())).rejects.toThrow('source changed');
  expect(state.report).not.toHaveBeenCalled();
});

it('keeps all sources in the local ledger and posts only verified public and organization calls', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const db = new Database(':memory:');
  for (const migration of ['0128_demonic_odin', '0132_abnormal_dazzler']) {
    db.exec(readFileSync(new URL(`../../../../drizzle/${migration}.sql`, import.meta.url), 'utf8'));
  }
  const client = { tx: async (_name: string, args: unknown) => runPluginUsageTransaction(db, args) } as DbClient;
  const service = new PluginUsageService({ client, isCurrent: () => true, deviceName: 'Test', reporting: createPluginUsageReporting('owner'), warn: vi.fn() });
  state.report.mockImplementation(async (_id, rows) => ({
    accepted: rows.map(({ eventId, count }: { eventId: string; count: number }) => ({ eventId, count })),
    duplicate: [], rejected: [],
  }));
  const sources = ([
    { ...identity, ghostId: 'official', pluginId: 'official' },
    { ...identity, ghostId: 'community', pluginId: 'community', displayName: 'Individual publisher' },
    { ...identity, ghostId: 'enterprise', pluginId: 'enterprise', reportingScope: 'organization', organizationId: 'org' },
    { ...identity, ghostId: 'private', pluginId: 'private', reportingScope: 'personal' },
    { ...identity, ghostId: 'manual', pluginId: 'manual', sourceKind: 'manual' },
    { ...identity, ghostId: 'git', pluginId: 'git', sourceKind: 'git-market' },
    { ...identity, ghostId: 'custom', pluginId: 'custom', sourceKind: 'local-market' },
  ] satisfies PluginUsageIdentity[]).map(source => ({ ...source, stableKey: source.ghostId }));
  try {
    for (const source of sources) {
      const handle = (await service.ensure(source))!;
      service.accept(handle, source.ghostId, 'status', null, Date.now());
    }
    await vi.advanceTimersByTimeAsync(640_000);
    expect(db.prepare('SELECT call_id FROM plugin_usage_events ORDER BY call_id').all())
      .toEqual(sources.map(source => source.ghostId).sort().map(call_id => ({ call_id })));
    expect(state.report.mock.calls.map(([id]) => id).sort()).toEqual(['community', 'enterprise', 'official']);
  } finally {
    await service.close();
    db.close();
    vi.useRealTimers();
  }
});
