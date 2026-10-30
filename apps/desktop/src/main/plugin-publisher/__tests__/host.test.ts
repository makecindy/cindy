import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PluginPublisherApiDeps } from '../api.js';
import type { PluginPublisherOrchestratorDeps } from '../orchestrator.js';

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), refresh: vi.fn(), authListener: vi.fn(),
  owner: vi.fn(() => ({ dataOwnerId: 'member-1', ownerGeneration: 1 })),
  create: vi.fn(), start: vi.fn(() => ({ transferId: 'transfer-1', uploadId: null })),
  abort: vi.fn(), getToken: vi.fn(async () => 'connection-token'), invalidate: vi.fn(),
  inspect: vi.fn(), listAll: vi.fn(),
}));

vi.mock('electron', () => ({ app: { getVersion: () => '1.0.0' } }));
vi.mock('../../plugin-market/api.js', () => ({
  PluginMarketApi: class { listAll = mocks.listAll; },
}));
vi.mock('../../appSessionState.js', () => ({ getActiveDataOwnerPushStamp: mocks.owner }));
vi.mock('../../authManager.js', () => ({
  getAuthState: mocks.auth, refresh: mocks.refresh, onAuthStateChange: mocks.authListener,
}));
vi.mock('../../cindy-brain/index.js', () => ({
  getConnectionTokenProvider: () => ({ getToken: mocks.getToken, invalidate: mocks.invalidate }),
  getGhostManager: () => ({ inspect: mocks.inspect }), sendToTrustedAppWindows: () => 1,
}));
vi.mock('../../cindy-brain/connectionAudienceResolver.js', () => ({
  isReservedConnectionPluginSlug: () => false,
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }));
vi.mock('../../lifecycle.js', () => ({ onQuit: vi.fn() }));
vi.mock('../api.js', () => ({
  PluginPublisherApi: class {
    constructor(public deps: PluginPublisherApiDeps) {}
  },
}));
vi.mock('../orchestrator.js', () => ({
  PluginPublisherOrchestrator: class {},
  createPluginPublisherOrchestrator: mocks.create,
}));

function member(orgSlug: string | null | undefined = undefined) {
  return {
    isAuthenticated: true,
    user: { id: 'member-1', membershipKind: 'org', orgId: 'org-1', orgName: 'Acme', orgSlug },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.auth.mockReturnValue(member());
  mocks.owner.mockReturnValue({ dataOwnerId: 'member-1', ownerGeneration: 1 });
  mocks.refresh.mockResolvedValue(false);
  mocks.listAll.mockResolvedValue({ plugins: [], removals: [], currentOrganization: null });
  mocks.create.mockReturnValue({ start: mocks.start, abortAll: mocks.abort });
});

async function host() {
  return import('../host.js');
}

function dependencies(): PluginPublisherOrchestratorDeps {
  return mocks.create.mock.calls[0][0] as PluginPublisherOrchestratorDeps;
}

describe('publisher old-token organization compatibility', () => {
  it('uses the validated S1 market namespace for the exact Auth organization when refresh keeps the claim absent', async () => {
    mocks.listAll.mockResolvedValue({
      plugins: [], removals: [],
      currentOrganization: { organizationId: 'org-1', orgSlug: 'actual-org', pluginPrefix: 'legacy' },
    });
    const publisher = await host();
    publisher.startPluginPublish('/tmp/legacy-helper.cindy');
    expect(await dependencies().identity()).toEqual({
      membershipId: 'member-1', orgSlug: 'actual-org', orgName: 'Acme',
    });
    expect(mocks.auth().user.orgSlug).toBeUndefined();
    const api = dependencies().api as unknown as { deps: { getToken(): Promise<string> } };
    await api.deps.getToken();
    expect(mocks.getToken).toHaveBeenCalledWith({
      membershipId: 'member-1', audience: 'actual-org:cindy-publisher',
    });
    expect(mocks.listAll).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
  });

  it('provides the running app version to the publisher HTTP client', async () => {
    (await host()).getPluginPublisherOrchestrator();
    const api = dependencies().api as unknown as { deps: PluginPublisherApiDeps };
    expect(api.deps.getClientVersion()).toBe('1.0.0');
  });

  it('rejects a valid market namespace for a foreign organization even with the same legal prefix', async () => {
    mocks.listAll.mockResolvedValue({
      plugins: [], removals: [],
      currentOrganization: { organizationId: 'org-foreign', orgSlug: 'foreign', pluginPrefix: 'legacy' },
    });
    const publisher = await host();
    publisher.startPluginPublish('/tmp/legacy-helper.cindy');
    expect(await dependencies().identity()).toMatchObject({ orgSlug: null });
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it.each(
    ['refresh', 'market'].flatMap((phase) =>
      ['membership', 'organization', 'owner'].map((change) => ({ phase, change })),
    ),
  )('rejects a late namespace after $change changes during $phase', async ({ phase, change }) => {
    const publisher = await host();
    const changeContext = () => {
      const next = member(phase === 'refresh' ? 'actual-org' : undefined);
      if (change === 'membership') next.user.id = 'member-2';
      if (change === 'organization') next.user.orgId = 'org-2';
      if (change === 'owner') mocks.owner.mockReturnValue({ dataOwnerId: 'member-1', ownerGeneration: 2 });
      mocks.auth.mockReturnValue(next);
      mocks.authListener.mock.calls[0][0]();
    };
    mocks.refresh.mockImplementation(async () => {
      if (phase === 'refresh') changeContext();
      return true;
    });
    mocks.listAll.mockImplementation(async () => {
      changeContext();
      return {
        plugins: [], removals: [],
        currentOrganization: { organizationId: 'org-1', orgSlug: 'actual-org', pluginPrefix: 'legacy' },
      };
    });
    publisher.startPluginPublish('/tmp/legacy-helper.cindy');
    expect(await dependencies().identity()).toBeNull();
    expect(mocks.getToken).not.toHaveBeenCalled();
    expect(mocks.abort).toHaveBeenCalledTimes(1);
    expect(mocks.listAll).toHaveBeenCalledTimes(phase === 'market' ? 1 : 0);
  });

  it('does not use a prefix as a namespace when the market row has no orgSlug', async () => {
    mocks.listAll.mockResolvedValue({
      plugins: [], removals: [], currentOrganization: { organizationId: 'org-1', pluginPrefix: 'xd' },
    });
    const publisher = await host();
    publisher.startPluginPublish('/tmp/xd-helper.cindy');
    expect(await dependencies().identity()).toMatchObject({ orgSlug: null });
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it('does not reuse the market identity cache after Auth organization changes without changing membership', async () => {
    mocks.listAll.mockResolvedValue({
      plugins: [], removals: [],
      currentOrganization: { organizationId: 'org-1', orgSlug: 'actual-org', pluginPrefix: null },
    });
    const publisher = await host();
    publisher.startPluginPublish('/tmp/helper.cindy');
    expect(await dependencies().identity()).toMatchObject({ orgSlug: 'actual-org' });
    const next = member();
    next.user.orgId = 'org-2';
    mocks.auth.mockReturnValue(next);
    expect(publisher.currentPublisherIdentity()).toMatchObject({ orgSlug: null });
    expect(await dependencies().identity()).toMatchObject({ orgSlug: null });
    expect(mocks.listAll).toHaveBeenCalledTimes(2);
  });

  it('reports unavailable namespace rather than adopting identity on a failed market lookup', async () => {
    mocks.listAll.mockRejectedValue(new Error('invalid market response'));
    const publisher = await host();
    publisher.startPluginPublish('/tmp/legacy-helper.cindy');
    expect(await dependencies().identity()).toMatchObject({ orgSlug: null });
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it.each([null, undefined])('keeps a real old organization membership with missing slug=%s', async (orgSlug) => {
    mocks.auth.mockReturnValue(member(orgSlug));
    expect((await host()).currentPublisherIdentity()).toEqual({
      membershipId: 'member-1', orgSlug: null, orgName: 'Acme',
    });
  });

  it('starts old legal-prefix publication and resolves only the real refreshed namespace', async () => {
    const publisher = await host();
    mocks.refresh.mockImplementation(async () => {
      mocks.auth.mockReturnValue(member('actual-org'));
      mocks.authListener.mock.calls[0][0]();
      return true;
    });
    expect(publisher.startPluginPublish('/tmp/old-prefix-helper.cindy').transferId).toBe('transfer-1');
    expect(await dependencies().identity()).toEqual({
      membershipId: 'member-1', orgSlug: 'actual-org', orgName: 'Acme',
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.abort).not.toHaveBeenCalled();
    const api = dependencies().api as unknown as { deps: { getToken(): Promise<string> } };
    await api.deps.getToken();
    expect(mocks.getToken).toHaveBeenCalledWith({
      membershipId: 'member-1', audience: 'actual-org:cindy-publisher',
    });
  });

  it('preserves natural names with a true namespace without a prefix lookup or refresh', async () => {
    mocks.auth.mockReturnValue(member('xd'));
    mocks.inspect.mockResolvedValue({ canonicalManifest: { id: 'helper', name: 'Helper', version: '1.0.0' } });
    const publisher = await host();
    publisher.startPluginPublish('/tmp/helper.cindy');
    expect(await dependencies().identity()).toMatchObject({ orgSlug: 'xd' });
    expect(await dependencies().inspectPackage('/tmp/helper.cindy')).toMatchObject({ ghostId: 'helper' });
    expect(publisher.publisherAudience('xd')).toBe('xd:cindy-publisher');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it('does not invent a namespace when refresh cannot provide one', async () => {
    const publisher = await host();
    publisher.startPluginPublish('/tmp/xd-helper.cindy');
    expect(await dependencies().identity()).toEqual({
      membershipId: 'member-1', orgSlug: null, orgName: 'Acme',
    });
    expect(() => publisher.publisherAudience(null as unknown as string)).toThrow();
    expect(mocks.getToken).not.toHaveBeenCalled();
  });

  it('still rejects personal membership and an explicitly invalid namespace', async () => {
    const publisher = await host();
    mocks.auth.mockReturnValue({ isAuthenticated: true, user: { ...member().user, membershipKind: 'personal' } });
    expect(publisher.currentPublisherIdentity()).toBeNull();
    mocks.auth.mockReturnValue(member('bad:slug'));
    expect(publisher.currentPublisherIdentity()).toBeNull();
    expect(() => publisher.publisherAudience('bad:slug')).toThrow();
  });
});
