import { beforeEach, expect, it, vi } from 'vitest';
import type { PluginUsageIdentity } from '../../../shared/pluginUsage';
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
  getAccessToken: () => state.token,
  getCurrentUserId: () => state.owner,
  isLocalMode: () => state.local,
}));
vi.mock('../../analytics-settings-store', () => ({ isAnalyticsAllowed: () => state.allowed }));
vi.mock('../../clientEndpointsService', () => ({ getClientEndpoint: () => state.root }));
vi.mock('../../plugin-market/api', () => ({
  PluginMarketApi: class {
    reportUsage = state.report;
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
  expect(r.target(identity)).toMatchObject({ serverRoot: 'https://one', ownerId: 'owner' });
  for (const change of [
    { sourceKind: 'manual' as const },
    { sourceKind: 'git-market' as const },
    { reportingScope: 'personal' as const },
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
    expect(r.canSend(target)).toBe(false);
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
  await expect(r.send(target, [], vi.fn())).rejects.toThrow('source changed');
});
