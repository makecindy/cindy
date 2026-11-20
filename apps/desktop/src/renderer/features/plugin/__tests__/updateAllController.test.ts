/**
 * Regression coverage for the module-level update-all controller.
 * Every row delegates validation and atomic placement to Main; this module owns
 * progress only.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let installedGhosts: Array<{
  manifest: GhostManifest;
  approval?: GhostInstallApproval;
  namespace?: string | null;
  namespaceState?: 'confirmed';
  dir?: string;
}> = [];
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  readInstalledGhostsSnapshot: () =>
    installedGhosts.map((ghost) => ({
      ...ghost,
      dir: ghost.dir ?? `C:/test/${ghost.manifest.id}`,
      enabled: true,
      approval: ghost.approval ?? {
        state: 'approved',
        revision: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      },
    })),
}));

import {
  __testing as dataOwnerTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { readInstalledGhostsSnapshot } from '@/cindy-brain/useInstalledGhosts';
import { toast } from '@/lib/toast';
import { collectUpdateConsent } from '../lib/updateAllConsent';
import { installedGhostStoragePart } from '../../../../shared/pluginIdentity';
import type { GhostInstallApproval, GhostManifest } from '../../../../shared/ghost';
import type { PluginMarketDetail, PluginMarketItem } from '../../../../shared/pluginMarket';
import {
  __resetUpdateAllBatchForTest,
  getUpdateAllBatchState,
  reconcileUpdateAllBatch,
  setUpdateAllBatchHooks,
  startUpdateAllBatch,
} from '../lib/updateAllController';

function manifest(overrides: Partial<GhostManifest> = {}): GhostManifest {
  return {
    id: 'ghost-a',
    name: 'Ghost A',
    version: '1.1.0',
    ...overrides,
  } as GhostManifest;
}

function marketItem(overrides: Partial<PluginMarketItem> = {}): PluginMarketItem {
  return {
    pluginId: 'plugin-a',
    ghostId: 'ghost-a',
    name: 'Ghost A',
    description: '',
    author: null,
    scope: 'public',
    organizationId: null,
    defaultInstall: false,
    releaseId: 'release-2',
    version: '1.1.0',
    publishedAt: '2026-08-01T00:00:00.000Z',
    icon: null,
    installState: 'update-available',
    enabled: true,
    sourceType: 'server',
    sourceMarketName: null,
    ...overrides,
  };
}

function detail(overrides: Partial<PluginMarketDetail> = {}): PluginMarketDetail {
  const item = marketItem(overrides);
  return {
    ...item,
    manifest: manifest({ id: item.ghostId, version: item.version }),
    readme: null,
    ...overrides,
  } as PluginMarketDetail;
}

const detailMock = vi.fn<(pluginId: string) => Promise<PluginMarketDetail>>();
const installMock = vi.fn();
const DEFAULT_APPROVAL_TOKEN = 'approved:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

async function waitForFinishedBatch(): Promise<void> {
  await vi.waitFor(() => {
    const current = getUpdateAllBatchState();
    expect(current.running).toBe(false);
    expect(
      current.rows?.some((row) => row.status === 'pending' || row.status === 'installing'),
    ).toBe(false);
  });
}

beforeEach(() => {
  __resetUpdateAllBatchForTest();
  dataOwnerTesting.reset();
  setDataOwnerGeneration('owner-a');
  installedGhosts = [{ manifest: manifest({ version: '1.0.0' }) }];
  detailMock.mockReset();
  detailMock.mockResolvedValue(detail());
  installMock.mockReset();
  installMock.mockResolvedValue({ ghost: { manifest: manifest() } });
  vi.mocked(toast.success).mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    appVersion: '1.0.0',
    pluginMarket: {
      detail: detailMock,
      install: installMock,
      // The runner brackets each row for the progress ring; these tests do not push any steps.
      onInstallProgress: () => () => undefined,
    },
  };
});

describe('updateAllController', () => {
  it('serially delegates every row with its release and installed receipt preconditions', async () => {
    installedGhosts.push({ manifest: manifest({ id: 'ghost-b', version: '2.0.0' }) });
    detailMock.mockImplementation(async (pluginId) =>
      pluginId === 'plugin-a'
        ? detail()
        : detail({
            pluginId: 'plugin-b',
            ghostId: 'ghost-b',
            releaseId: 'release-b2',
            version: '2.1.0',
          }),
    );

    startUpdateAllBatch([
      marketItem(),
      marketItem({
        pluginId: 'plugin-b',
        ghostId: 'ghost-b',
        releaseId: 'release-b2',
        version: '2.1.0',
      }),
    ]);
    await waitForFinishedBatch();

    expect(installMock.mock.calls).toEqual([
      [
        'plugin-a',
        {
          expectedReleaseId: 'release-2',
          expectedManifest: manifest(),
          expectedInstalledApproval: DEFAULT_APPROVAL_TOKEN,
          allowSourceReplacement: false,
          batchRowId: expect.any(String),
        },
      ],
      [
        'plugin-b',
        {
          expectedReleaseId: 'release-b2',
          expectedManifest: manifest({ id: 'ghost-b', version: '2.1.0' }),
          expectedInstalledApproval: DEFAULT_APPROVAL_TOKEN,
          allowSourceReplacement: false,
          batchRowId: expect.any(String),
        },
      ],
    ]);
    expect(getUpdateAllBatchState().rows?.map((row) => row.status)).toEqual(['done', 'done']);
  });

  it('skips a plugin removed before its row starts', async () => {
    installedGhosts = [];

    startUpdateAllBatch([marketItem()]);
    await waitForFinishedBatch();

    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('skipped');
    expect(installMock).not.toHaveBeenCalled();
  });

  it('settles a release already installed by another flow without downloading again', async () => {
    detailMock.mockResolvedValueOnce(detail({ installState: 'installed' }));

    startUpdateAllBatch([marketItem()]);
    await waitForFinishedBatch();

    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
    expect(installMock).not.toHaveBeenCalled();
  });

  it('skips a queued update that changed to a source conflict before its turn', async () => {
    installedGhosts.push({ manifest: manifest({ id: 'ghost-b', version: '2.0.0' }) });
    let resolveFirstInstall: (() => void) | undefined;
    installMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirstInstall = () => resolve({ ghost: { manifest: manifest() } });
        }),
    );
    detailMock.mockImplementation(async (pluginId) =>
      pluginId === 'plugin-a'
        ? detail()
        : detail({
            pluginId: 'plugin-b',
            ghostId: 'ghost-b',
            installState: 'conflict',
          }),
    );

    startUpdateAllBatch([marketItem(), marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' })]);
    await vi.waitFor(() => expect(resolveFirstInstall).toBeDefined());
    resolveFirstInstall?.();
    await waitForFinishedBatch();

    expect(installMock).toHaveBeenCalledTimes(1);
    expect(getUpdateAllBatchState().rows?.[1]?.status).toBe('skipped');
  });

  it('keeps ordinary install failures as terminal failed rows', async () => {
    installMock.mockRejectedValueOnce(new Error('network down'));

    startUpdateAllBatch([marketItem()]);
    await waitForFinishedBatch();

    expect(getUpdateAllBatchState().rows?.[0]).toMatchObject({
      status: 'failed',
      errorText: 'settings.ghosts.market.errors.generic',
    });
  });

  it('does not re-check the server-selected release against the client version', async () => {
    detailMock.mockResolvedValueOnce(
      detail({ manifest: manifest({ minCindyVersion: '99.0.0' }) }),
    );

    startUpdateAllBatch([marketItem()]);
    await waitForFinishedBatch();

    expect(installMock).toHaveBeenCalledWith(
      'plugin-a',
      expect.objectContaining({ expectedReleaseId: 'release-2' }),
    );
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
  });

  it('voids the whole batch when its data owner changes during detail loading', async () => {
    let resolveDetail: ((value: PluginMarketDetail) => void) | undefined;
    detailMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveDetail = resolve;
        }),
    );

    startUpdateAllBatch([marketItem()]);
    await vi.waitFor(() => expect(resolveDetail).toBeDefined());
    setDataOwnerGeneration('owner-b');
    resolveDetail?.(detail());
    await vi.waitFor(() => expect(getUpdateAllBatchState().running).toBe(false));

    expect(getUpdateAllBatchState().rows).toBeNull();
    expect(installMock).not.toHaveBeenCalled();
  });

  it('keeps running until the post-batch market refresh finishes', async () => {
    let resolveRefresh: (() => void) | undefined;
    setUpdateAllBatchHooks({
      refreshMarket: () =>
        new Promise<void>((resolve) => {
          resolveRefresh = resolve;
        }),
    });

    startUpdateAllBatch([marketItem()]);
    await vi.waitFor(() => expect(resolveRefresh).toBeDefined());
    expect(getUpdateAllBatchState().running).toBe(true);

    startUpdateAllBatch([marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' })]);
    expect(getUpdateAllBatchState().rows?.map((row) => row.pluginId)).toEqual(['plugin-a']);

    resolveRefresh?.();
    await waitForFinishedBatch();
    expect(toast.success).toHaveBeenCalledTimes(1);
  });


  it('updates the physical root when a namespaced twin shares the ghostId', async () => {
    const namespacedApproval = {
      state: 'approved' as const,
      revision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    installedGhosts = [
      {
        manifest: manifest({ version: '9.0.0' }),
        namespace: 'xd',
        dir: 'C:/test/_ns/xd/ghost-a',
        approval: namespacedApproval,
      },
      { manifest: manifest({ version: '1.0.0' }), dir: 'C:/test/ghost-a' },
    ];

    startUpdateAllBatch([marketItem()]);
    await waitForFinishedBatch();

    expect(getUpdateAllBatchState().rows?.[0]).toMatchObject({
      status: 'done',
      fromVersion: '1.0.0',
    });
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(installMock.mock.calls[0]?.[1]).toMatchObject({
      expectedInstalledApproval: DEFAULT_APPROVAL_TOKEN,
    });
  });

  it('updates the namespaced instance for an organization market row', async () => {
    const namespacedApproval = {
      state: 'approved' as const,
      revision: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    installedGhosts = [
      { manifest: manifest({ version: '1.0.0' }), dir: 'C:/test/ghost-a' },
      {
        manifest: manifest({ version: '9.0.0' }),
        namespace: 'xd',
        dir: 'C:/test/_ns/xd/ghost-a',
        approval: namespacedApproval,
      },
    ];
    detailMock.mockResolvedValue(
      detail({
        pluginId: 'plugin-org',
        namespace: 'xd',
        scope: 'organization',
        version: '9.1.0',
        releaseId: 'release-org',
      }),
    );

    startUpdateAllBatch([
      marketItem({
        pluginId: 'plugin-org',
        namespace: 'xd',
        scope: 'organization',
        version: '9.1.0',
        releaseId: 'release-org',
      }),
    ]);
    await waitForFinishedBatch();

    expect(getUpdateAllBatchState().rows?.[0]).toMatchObject({
      status: 'done',
      fromVersion: '9.0.0',
    });
    expect(installMock.mock.calls[0]).toEqual([
      'plugin-org',
      {
        expectedReleaseId: 'release-org',
        expectedManifest: manifest({ version: '9.1.0' }),
        expectedInstalledApproval: 'approved:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        allowSourceReplacement: false,
        batchRowId: expect.any(String),
      },
    ]);
  });

  it('skips a public update when only a namespaced twin is installed', async () => {
    installedGhosts = [
      {
        manifest: manifest({ version: '9.0.0' }),
        namespace: 'xd',
        dir: 'C:/test/_ns/xd/ghost-a',
      },
    ];

    startUpdateAllBatch([marketItem()]);
    await waitForFinishedBatch();

    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('skipped');
    expect(installMock).not.toHaveBeenCalled();
  });

  it('reconciles a pending row removed while an earlier row is installing', async () => {
    installedGhosts.push({ manifest: manifest({ id: 'ghost-b', version: '2.0.0' }) });
    let resolveInstall: (() => void) | undefined;
    installMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveInstall = () => resolve({ ghost: { manifest: manifest() } });
        }),
    );
    detailMock.mockImplementation(async (pluginId) =>
      pluginId === 'plugin-a' ? detail() : detail({ pluginId: 'plugin-b', ghostId: 'ghost-b' }),
    );

    startUpdateAllBatch([marketItem(), marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' })]);
    await vi.waitFor(() => expect(resolveInstall).toBeDefined());
    installedGhosts = [{ manifest: manifest({ version: '1.0.0' }) }];
    reconcileUpdateAllBatch();
    expect(getUpdateAllBatchState().rows?.[1]?.status).toBe('skipped');

    resolveInstall?.();
    await waitForFinishedBatch();
    expect(installMock).toHaveBeenCalledTimes(1);
  });

  // GitHub Release rows (local plugins with `githubRelease`) join the same batch but go through
  // Main's `ghosts:github-release` update, which re-checks the release before downloading. Before
  // this change the banner and batch only knew market rows, so these plugins were never offered.
  // Branches: Main pointing at a newer asset ends this attempt; a sign-in answer is a failed row
  // with the release row's own words; the market row in the same batch is unaffected.
  it.each([
    {
      name: 'leaves a newer asset for the next update attempt',
      replies: [
        { status: 'available', release: { version: '0.1.2', assetId: 8, sha256: 'b', size: 1, prerelease: false } },
      ],
      assets: [7],
      row: { status: 'failed', toVersion: '0.1.1', errorText: 'settings.ghosts.detail.githubRelease.unavailable' },
    },
    {
      name: 'fails the row with the GitHub sign-in prompt',
      replies: [{ status: 'sign-in' }],
      assets: [7],
      row: { status: 'failed', errorText: 'settings.ghosts.detail.githubRelease.sign-in' },
    },
  ])('updates a GitHub Release row through Main: $name', async ({ replies, assets, row }) => {
    installedGhosts.push({
      manifest: manifest({
        id: 'zcode',
        name: 'ZCode',
        version: '0.1.0',
        githubRelease: 'example/zcode',
        settingsHtml: 'settings.html',
      } as Partial<GhostManifest>),
      namespace: 'local',
      namespaceState: 'confirmed',
    });
    const instanceId = installedGhostStoragePart(readInstalledGhostsSnapshot()[1]!);
    const githubRelease = vi.fn();
    for (const reply of replies) githubRelease.mockResolvedValueOnce(reply);
    (window as unknown as { electronAPI: { ghosts: unknown } }).electronAPI.ghosts = {
      githubRelease,
      onGithubReleaseProgress: () => () => undefined,
    };

    // A mixed batch must settle the market permission review before starting a release update.
    let approve!: (ids: Set<string>) => void;
    const review = vi.fn(() => new Promise<Set<string>>(resolve => { approve = resolve; }));
    installMock.mockImplementationOnce(async (_pluginId, { batchRowId }) => {
      const accepted = await collectUpdateConsent({
        requestId: 'market-request', batchRowId, initiator: 'user', origin: 'market',
        facts: {
          kind: 'update', ghostId: 'ghost-a', name: 'Ghost A', previousVersion: '1.0.0', version: '1.1.0',
          added: [], removed: [], unchangedCount: 0, builtinOauthClientChanged: true,
        },
      }, new AbortController().signal, review);
      expect(accepted).toBe(true);
    });

    startUpdateAllBatch(
      [marketItem()],
      [{ instanceId, ghostId: 'zcode', name: 'ZCode', fromVersion: '0.1.0', version: '0.1.1', assetId: 7 }],
    );
    await vi.waitFor(() => expect(review).toHaveBeenCalledTimes(1));
    expect(githubRelease).not.toHaveBeenCalled();
    approve(new Set(['market-request']));
    await waitForFinishedBatch();

    expect(githubRelease.mock.calls).toEqual(assets.map((asset) => ['update', instanceId, asset]));
    expect(installMock).toHaveBeenCalledTimes(1);
    expect(getUpdateAllBatchState().rows?.map((current) => current.status)).toEqual(['done', row.status]);
    expect(getUpdateAllBatchState().rows?.[1]).toMatchObject(row);
  });
});
