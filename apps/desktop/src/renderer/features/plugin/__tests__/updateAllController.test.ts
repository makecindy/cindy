/**
 * Regression coverage for the module-level update-all controller.
 * Permission review is intentionally absent here: every row delegates to the
 * Main-owned real-package transaction and this module owns progress only.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

let installedGhosts: Array<{ manifest: GhostManifest }> = [];
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({
  readInstalledGhostsSnapshot: () => installedGhosts,
}));

import {
  __testing as dataOwnerTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import { toast } from '@/lib/toast';
import type { GhostManifest } from '../../../../shared/ghost';
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
    slots: [],
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
    pluginMarket: { detail: detailMock, install: installMock },
  };
});

describe('updateAllController', () => {
  it('serially delegates every row with only its current release precondition', async () => {
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
      ['plugin-a', { expectedReleaseId: 'release-2', allowSourceReplacement: false }],
      ['plugin-b', { expectedReleaseId: 'release-b2', allowSourceReplacement: false }],
    ]);
    expect(getUpdateAllBatchState().rows?.map((row) => row.status)).toEqual([
      'done',
      'done',
    ]);
  });

  it('marks a Main-side permission cancellation as skipped', async () => {
    installMock.mockResolvedValueOnce({ cancelled: true });

    startUpdateAllBatch([marketItem()]);
    await waitForFinishedBatch();

    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('skipped');
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

    startUpdateAllBatch([
      marketItem(),
      marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' }),
    ]);
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

    startUpdateAllBatch([
      marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' }),
    ]);
    expect(getUpdateAllBatchState().rows?.map((row) => row.pluginId)).toEqual([
      'plugin-a',
    ]);

    resolveRefresh?.();
    await waitForFinishedBatch();
    expect(toast.success).toHaveBeenCalledTimes(1);
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
      pluginId === 'plugin-a'
        ? detail()
        : detail({ pluginId: 'plugin-b', ghostId: 'ghost-b' }),
    );

    startUpdateAllBatch([
      marketItem(),
      marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' }),
    ]);
    await vi.waitFor(() => expect(resolveInstall).toBeDefined());
    installedGhosts = [{ manifest: manifest({ version: '1.0.0' }) }];
    reconcileUpdateAllBatch();
    expect(getUpdateAllBatchState().rows?.[1]?.status).toBe('skipped');

    resolveInstall?.();
    await waitForFinishedBatch();
    expect(installMock).toHaveBeenCalledTimes(1);
  });
});
