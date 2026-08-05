/**
 * Regression coverage for the module-level update-all batch controller:
 * uninstall guards, reviewed-manifest passthrough, package-review baseline
 * drift recovery, and batch state surviving page unmount (review 定稿 2026-08-04).
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
import { ghostPermissionBaselineKey, type GhostManifest } from '../../../../shared/ghost';
import type { PluginMarketDetail, PluginMarketItem } from '../../../../shared/pluginMarket';
import {
  __resetUpdateAllBatchForTest,
  approveUpdateExpansion,
  getUpdateAllBatchState,
  reconcileUpdateAllBatch,
  setUpdateAllBatchHooks,
  startUpdateAllBatch,
} from '../lib/updateAllController';

function manifest(overrides: Partial<GhostManifest>): GhostManifest {
  return {
    id: 'ghost-a',
    name: 'Ghost A',
    version: '1.1.0',
    slots: [],
    ...overrides,
  } as GhostManifest;
}

function marketItem(overrides: Partial<PluginMarketItem>): PluginMarketItem {
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

const detailMock = vi.fn<(pluginId: string) => Promise<PluginMarketDetail>>();
const installMock = vi.fn(async () => ({ ghost: { manifest: manifest({}) } }) as never);

function stubDetail(overrides: {
  manifest: GhostManifest;
  sourceType: PluginMarketDetail['sourceType'];
}): void {
  detailMock.mockResolvedValue({
    ...marketItem({ sourceType: overrides.sourceType }),
    manifest: overrides.manifest,
    readme: null,
  } as unknown as PluginMarketDetail);
}

async function waitForSettledBatch(): Promise<void> {
  await vi.waitFor(() => {
    const state = getUpdateAllBatchState();
    expect(state.running).toBe(false);
    expect(state.rows?.some((row) => row.status === 'pending')).toBe(false);
  });
}

beforeEach(() => {
  __resetUpdateAllBatchForTest();
  dataOwnerTesting.reset();
  setDataOwnerGeneration('owner-a');
  detailMock.mockReset();
  // mockReset 而非 mockClear:用例可能装过"卡住不 resolve"的实现(并发编排),
  // 只清调用记录会让它泄漏到后面的用例里把 waitFor 全部拖超时。
  installMock.mockReset();
  installMock.mockResolvedValue({ ghost: { manifest: manifest({}) } } as never);
  vi.mocked(toast.success).mockClear();
  installedGhosts = [{ manifest: manifest({ version: '1.0.0' }) }];
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pluginMarket: { detail: detailMock, install: installMock },
  };
});

describe('updateAllController', () => {
  it('skips rows whose plugin was uninstalled mid-batch instead of reinstalling', async () => {
    installedGhosts = [];
    stubDetail({ manifest: manifest({}), sourceType: 'server' });

    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('skipped');
    expect(installMock).not.toHaveBeenCalled();
  });

  it('holds actual package permissions for approval', async () => {
    stubDetail({ manifest: manifest({}), sourceType: 'server' });
    const review = {
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      packageSha256: 'a'.repeat(64),
      installedBaseline: ghostPermissionBaselineKey(installedGhosts[0].manifest),
    };
    installMock.mockResolvedValueOnce({ reviewRequired: review } as never);

    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();
    expect(getUpdateAllBatchState().rows?.[0]).toMatchObject({
      status: 'needs-confirm',
      releaseId: 'release-2',
      packageReview: review,
    });

    await approveUpdateExpansion('plugin-a');
    expect(installMock).toHaveBeenLastCalledWith(
      'plugin-a',
      expect.objectContaining({
        approvedPackageSha256: review.packageSha256,
      }),
    );
  });

  it('keeps package review recoverable when the installed baseline drifts in flight', async () => {
    stubDetail({ manifest: manifest({}), sourceType: 'server' });
    const review = {
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      packageSha256: 'a'.repeat(64),
      installedBaseline: ghostPermissionBaselineKey(installedGhosts[0].manifest),
    };
    installMock.mockImplementationOnce(async () => {
      installedGhosts = [{ manifest: manifest({ version: '1.0.5', slots: ['fs'] }) }];
      return { reviewRequired: review } as never;
    });

    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    expect(getUpdateAllBatchState().rows?.[0]).toMatchObject({
      status: 'needs-confirm',
      staleReview: true,
      releaseId: 'release-2',
      fromVersion: '1.0.5',
      toVersion: '1.1.0',
    });

    await approveUpdateExpansion('plugin-a');
    expect(installMock).toHaveBeenLastCalledWith('plugin-a', {
      expectedReleaseId: 'release-2',
    });
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
  });

  it('passes the reviewed manifest back when approving a non-server expansion', async () => {
    const nextManifest = manifest({ network: { hosts: ['api.example.com'] } });
    stubDetail({ manifest: nextManifest, sourceType: 'git-market' });

    startUpdateAllBatch([marketItem({ sourceType: 'git-market' })]);
    await waitForSettledBatch();

    const held = getUpdateAllBatchState().rows?.[0];
    expect(held?.status).toBe('needs-confirm');
    expect(held?.expectedManifest).toBe(nextManifest);

    await approveUpdateExpansion('plugin-a');
    expect(installMock).toHaveBeenCalledWith('plugin-a', {
      expectedReleaseId: 'release-2',
      expectedManifest: nextManifest,
      allowPermissionExpansion: true,
      reviewedBaseline: expect.any(String),
    });
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
  });

  it('omits expectedManifest when approving a server-source expansion', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });

    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();
    await approveUpdateExpansion('plugin-a');

    expect(installMock).toHaveBeenCalledWith('plugin-a', {
      expectedReleaseId: 'release-2',
      allowPermissionExpansion: true,
      reviewedBaseline: expect.any(String),
    });
  });

  it('turns approval into a skip when the plugin was uninstalled while waiting', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });

    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    installedGhosts = [];
    await approveUpdateExpansion('plugin-a');

    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('skipped');
    expect(installMock).not.toHaveBeenCalled();
  });

  it('recomputes the diff when an external update replaced the permission baseline', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');

    // 「从文件更新」把插件装成了第三个版本,且它已自带原先要审的 network 权限:
    // 审阅过的 diff 与 allowPermissionExpansion 都不再对应现实。
    installedGhosts = [
      { manifest: manifest({ version: '1.0.5', network: { hosts: ['api.example.com'] } }) },
    ];
    reconcileUpdateAllBatch();
    const held = getUpdateAllBatchState().rows?.[0];
    expect(held).toMatchObject({ status: 'needs-confirm', staleReview: true, fromVersion: '1.0.5' });
    expect(held?.permissionDiff).toBeUndefined();

    await approveUpdateExpansion('plugin-a');
    // 相对当前已装 manifest 已无扩权 → 按普通更新安装,不带 allowPermissionExpansion。
    expect(installMock).toHaveBeenCalledWith('plugin-a', { expectedReleaseId: 'release-2' });
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
  });

  it('keeps the row held for re-review when the recomputed diff still expands permissions', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 外部装成第三个版本且权限面变了(多了 fs),但仍不含目标版本要新增的
    // network —— 基线失效触发重算,重算结果依旧是扩权。
    installedGhosts = [{ manifest: manifest({ version: '1.0.5', slots: ['fs'] }) }];
    reconcileUpdateAllBatch();
    await approveUpdateExpansion('plugin-a');

    const row = getUpdateAllBatchState().rows?.[0];
    expect(row).toMatchObject({ status: 'needs-confirm', staleReview: false, fromVersion: '1.0.5' });
    expect(row?.permissionDiff?.added.length).toBeGreaterThan(0);
    // 重算后仍是扩权:必须回到用户逐项审阅,绝不静默放行。
    expect(installMock).not.toHaveBeenCalled();
  });

  it('recomputes on baseline drift even before reconcile flagged the row', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 外部更新已落地但 reconcile 还没跑(竞态窗口):版本比较必须兜住,
    // 不得拿旧 diff 换来的 allowPermissionExpansion 安装。
    installedGhosts = [
      { manifest: manifest({ version: '1.0.5', network: { hosts: ['api.example.com'] } }) },
    ];
    await approveUpdateExpansion('plugin-a');

    expect(installMock).toHaveBeenCalledWith('plugin-a', { expectedReleaseId: 'release-2' });
  });

  it('invalidates the review when a same-version manifest swap widened permissions', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');

    // 「从文件更新」换入**同版本**但权限更宽的 manifest:版本号完全看不出来,
    // 沿用旧审阅会把 fs 这条从未审阅的权限一并放行。
    installedGhosts = [{ manifest: manifest({ version: '1.0.0', slots: ['fs'] }) }];
    reconcileUpdateAllBatch();
    const held = getUpdateAllBatchState().rows?.[0];
    expect(held).toMatchObject({ status: 'needs-confirm', staleReview: true });
    expect(held?.permissionDiff).toBeUndefined();

    await approveUpdateExpansion('plugin-a');
    // 相对新基线重算后仍是扩权 → 回到逐项审阅,绝不带 allowPermissionExpansion 放行。
    expect(installMock).not.toHaveBeenCalled();
    expect(getUpdateAllBatchState().rows?.[0]).toMatchObject({
      status: 'needs-confirm',
      staleReview: false,
    });
  });

  it('keeps the review valid when only the version moved but permissions are identical', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 权限面完全没变,只是版本号动了:审阅结论仍然成立,不该逼用户重审。
    installedGhosts = [{ manifest: manifest({ version: '1.0.4' }) }];
    reconcileUpdateAllBatch();
    const kept = getUpdateAllBatchState().rows?.[0];
    expect(kept).toMatchObject({ status: 'needs-confirm', fromVersion: '1.0.4' });
    expect(kept?.staleReview).toBeFalsy();
    expect(kept?.permissionDiff?.added.length).toBeGreaterThan(0);

    await approveUpdateExpansion('plugin-a');
    expect(installMock).toHaveBeenCalledWith('plugin-a', {
      expectedReleaseId: 'release-2',
      allowPermissionExpansion: true,
      reviewedBaseline: expect.any(String),
    });
  });

  it('voids the batch when the data owner changes during the detail round-trip', async () => {
    let releaseDetail: (() => void) | undefined;
    detailMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDetail = () => {
            setDataOwnerGeneration('owner-b');
            resolve({
              ...marketItem({}),
              manifest: manifest({}),
              readme: null,
            } as unknown as PluginMarketDetail);
          };
        }),
    );

    startUpdateAllBatch([marketItem({})]);
    await vi.waitFor(() => expect(releaseDetail).toBeDefined());
    releaseDetail?.();
    await vi.waitFor(() => expect(getUpdateAllBatchState().running).toBe(false));

    // 旧账号发起的批次在身份切换后整体作废,不得写入新账号数据。
    expect(getUpdateAllBatchState().rows).toBeNull();
    expect(installMock).not.toHaveBeenCalled();
  });

  it('reconcile settles held rows updated externally and voids stale-owner batches', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');

    // 目标 release 已落账(市场快照报 installed)→ 待确认行收束为完成。
    installedGhosts = [{ manifest: manifest({ version: '1.1.0' }) }];
    reconcileUpdateAllBatch([marketItem({ installState: 'installed' })]);
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
    expect(installMock).not.toHaveBeenCalled();

    // 账号切换后对账直接作废整批。
    startUpdateAllBatch([]);
    setDataOwnerGeneration('owner-b');
    reconcileUpdateAllBatch();
    expect(getUpdateAllBatchState().rows).toBeNull();
  });

  it('does not settle as done when a same-version foreign release was installed', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 「从文件更新」装了同版本但**不是目标 release** 的包:版本号看着到位,
    // 但 main 侧 record.releaseId 对不上,市场仍报 update-available。
    installedGhosts = [{ manifest: manifest({ version: '1.1.0' }) }];
    reconcileUpdateAllBatch([marketItem({ installState: 'update-available' })]);
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');

    await approveUpdateExpansion('plugin-a');
    // 目标 release 仍未落账 → 必须真正安装,不得凭版本号收成完成。
    expect(installMock).toHaveBeenCalledWith('plugin-a', {
      expectedReleaseId: 'release-2',
      allowPermissionExpansion: true,
      reviewedBaseline: expect.any(String),
    });
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
  });

  it('re-reads the installed manifest after detail() instead of trusting the pre-await snapshot', async () => {
    // 审阅基线:已装带 network,目标包在此之上多出 fs → 用户审的是 fs 这一条。
    installedGhosts = [
      { manifest: manifest({ version: '1.0.0', network: { hosts: ['api.example.com'] } }) },
    ];
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] }, slots: ['fs'] }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');

    // detail() 往返期间「从文件更新」把已装换成**不带 network** 的包:此刻目标包
    // 相对当前已装多出 network + fs,而 network 用户从没审过。批准必须以
    // detail 之后的事实判断,拿 await 前捕获的快照会直接放行。
    detailMock.mockImplementation(async () => {
      installedGhosts = [{ manifest: manifest({ version: '1.0.0' }) }];
      return {
        ...marketItem({}),
        manifest: manifest({ network: { hosts: ['api.example.com'] }, slots: ['fs'] }),
        readme: null,
      } as unknown as PluginMarketDetail;
    });

    await approveUpdateExpansion('plugin-a');
    expect(installMock).not.toHaveBeenCalled();
    const row = getUpdateAllBatchState().rows?.[0];
    expect(row?.status).toBe('needs-confirm');
    // 新差异按当前事实重算,把没审过的 network 也摆出来。
    expect(row?.permissionDiff?.added.length).toBeGreaterThan(1);
  });

  it('returns a Main-side baseline rejection to re-review instead of a terminal failure', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // Main 在安装锁内用当前已装 manifest 复核后否决了这次批准。
    installMock.mockRejectedValueOnce(
      Object.assign(new Error('[PRECONDITION_FAILED] baseline changed'), {
        message: 'Error invoking remote method: Error: [PRECONDITION_FAILED] baseline changed',
      }),
    );

    await approveUpdateExpansion('plugin-a');
    const row = getUpdateAllBatchState().rows?.[0];
    // 「事实已变,请重新审阅」而不是「更新失败」——终态失败会让用户失去入口。
    // 手里的 detail 已被 Main 否决,不能拿它出确认内容:丢弃旧差异 + 标记过期,
    // 下次批准重新取详情。
    expect(row?.status).toBe('needs-confirm');
    expect(row?.staleReview).toBe(true);
    expect(row?.permissionDiff).toBeUndefined();
    expect(row?.errorText).toBeUndefined();
  });

  it('holds running through the post-approval refresh so no second batch can start', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();
    expect(getUpdateAllBatchState().running).toBe(false);

    let releaseRefresh: (() => void) | undefined;
    setUpdateAllBatchHooks({
      refreshMarket: () =>
        new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        }),
    });

    const approving = approveUpdateExpansion('plugin-a');
    await vi.waitFor(() => expect(releaseRefresh).toBeDefined());
    // 刷新还没回来:页面手里仍是旧的 update-available 快照,必须挡住第二批。
    expect(getUpdateAllBatchState().running).toBe(true);
    startUpdateAllBatch([marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' })]);
    expect(getUpdateAllBatchState().rows?.map((row) => row.pluginId)).toEqual(['plugin-a']);

    releaseRefresh?.();
    await approving;
    expect(getUpdateAllBatchState().running).toBe(false);
  });

  it('serialises concurrent approvals and only settles after the last one', async () => {
    const expanding = manifest({ network: { hosts: ['api.example.com'] } });
    detailMock.mockImplementation(async (pluginId) =>
      ({
        ...marketItem({ pluginId, ghostId: pluginId === 'plugin-a' ? 'ghost-a' : 'ghost-b' }),
        manifest: expanding,
        readme: null,
      }) as unknown as PluginMarketDetail,
    );
    installedGhosts = [
      { manifest: manifest({ version: '1.0.0' }) },
      { manifest: manifest({ id: 'ghost-b', version: '1.0.0' }) },
    ];
    startUpdateAllBatch([
      marketItem({}),
      marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' }),
    ]);
    await waitForSettledBatch();
    expect(
      getUpdateAllBatchState().rows?.every((row) => row.status === 'needs-confirm'),
    ).toBe(true);

    // 两次安装都卡住,用来观察是否并发。
    const installGate: Array<() => void> = [];
    let concurrentPeak = 0;
    let active = 0;
    installMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          active += 1;
          concurrentPeak = Math.max(concurrentPeak, active);
          installGate.push(() => {
            active -= 1;
            resolve({ ghost: { manifest: expanding } } as never);
          });
        }),
    );
    let refreshCalls = 0;
    setUpdateAllBatchHooks({
      refreshMarket: async () => {
        refreshCalls += 1;
      },
    });

    // 用户连点两个「同意」。
    const first = approveUpdateExpansion('plugin-a');
    const second = approveUpdateExpansion('plugin-b');

    await vi.waitFor(() => expect(installGate.length).toBe(1));
    // 串行:第二个必须排队,不能与第一个同时在装。
    expect(concurrentPeak).toBe(1);
    expect(getUpdateAllBatchState().running).toBe(true);

    installGate[0]?.();
    await first;
    // 第一个结束时还有在途批准 → 不许提前释放闸门、不许提前报完成。
    expect(getUpdateAllBatchState().running).toBe(true);
    expect(refreshCalls).toBe(0);

    await vi.waitFor(() => expect(installGate.length).toBe(2));
    installGate[1]?.();
    await second;

    // 最后一个结束才收尾:刷新一次、释放 running、报一次完成。
    expect(concurrentPeak).toBe(1);
    expect(getUpdateAllBatchState().running).toBe(false);
    expect(refreshCalls).toBe(1);
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
  });

  it('skips a row whose target release was already installed by the single-item flow', async () => {
    // 用户在批次启动前用卡片的单项更新装了同一个 release;本批次拿的是那之前的
    // 市场快照,仍标 update-available。runner 取详情后必须发现已落账并跳过。
    detailMock.mockResolvedValue({
      ...marketItem({ installState: 'installed' }),
      manifest: manifest({ version: '1.1.0' }),
      readme: null,
    } as unknown as PluginMarketDetail);

    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
    expect(installMock).not.toHaveBeenCalled();
  });

  it('holds a runner row for re-review instead of failing it on PRECONDITION_FAILED', async () => {
    stubDetail({ manifest: manifest({}), sourceType: 'git-market' });
    installMock.mockRejectedValueOnce(
      Object.assign(new Error('precondition'), {
        message: 'Error invoking remote method: Error: [PRECONDITION_FAILED] release changed',
      }),
    );

    startUpdateAllBatch([marketItem({ sourceType: 'git-market' })]);
    await waitForSettledBatch();

    const row = getUpdateAllBatchState().rows?.[0];
    // 自动安装路径遇到前置条件变化 → 可恢复的待重审,不是终态失败。
    expect(row).toMatchObject({ status: 'needs-confirm', staleReview: true });
    expect(row?.errorText).toBeUndefined();
    expect(row?.permissionDiff).toBeUndefined();
  });

  it('lets a held runner row be re-reviewed and approved through to completion', async () => {
    stubDetail({ manifest: manifest({}), sourceType: 'git-market' });
    installMock.mockRejectedValueOnce(
      Object.assign(new Error('precondition'), {
        message: 'Error invoking remote method: Error: [PRECONDITION_FAILED] release changed',
      }),
    );

    startUpdateAllBatch([marketItem({ sourceType: 'git-market' })]);
    await waitForSettledBatch();

    const held = getUpdateAllBatchState().rows?.[0];
    expect(held).toMatchObject({ status: 'needs-confirm', staleReview: true });
    // 关键:待重审行必须带着目标 release,否则 approve 的入口守卫会直接返回,
    // 用户点「重新审阅」毫无反应,该项在本批次里永远走不下去。
    expect(held?.releaseId).toBe('release-2');

    // 点「重新审阅」→ 重取详情、按当前事实重算(已无扩权)→ 装上收尾。
    await approveUpdateExpansion('plugin-a');

    expect(installMock).toHaveBeenLastCalledWith('plugin-a', {
      expectedReleaseId: 'release-2',
      expectedManifest: expect.anything(),
    });
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
  });

  it('fails instead of holding when there is no target release to re-review', async () => {
    // detail 拿得到、但 install 前置条件失败且行上没有 releaseId 的极端情形:
    // 用 detail 报 installed 之外的路径构造——这里直接验证 hold 的防御分支,
    // 保证不会产出「点不动的 needs-confirm 死行」。
    detailMock.mockResolvedValue({
      ...marketItem({ releaseId: '' }),
      manifest: manifest({}),
      readme: null,
    } as unknown as PluginMarketDetail);
    installMock.mockRejectedValueOnce(
      Object.assign(new Error('precondition'), {
        message: 'Error invoking remote method: Error: [PRECONDITION_FAILED] gone',
      }),
    );

    startUpdateAllBatch([marketItem({ releaseId: '' })]);
    await waitForSettledBatch();

    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('failed');
  });

  it('still fails the row on non-precondition install errors', async () => {
    stubDetail({ manifest: manifest({}), sourceType: 'server' });
    installMock.mockRejectedValueOnce(new Error('network down'));

    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 真失败仍然是失败:不能把所有错误都变成"再审一次"。
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('failed');
  });

  it('re-reviews instead of failing when a custom source swaps the manifest under the plain update path', async () => {
    // 自定义市场源:审阅基线含 network,目标包在此之上多出 fs。
    installedGhosts = [
      { manifest: manifest({ version: '1.0.0', network: { hosts: ['api.example.com'] } }) },
    ];
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] }, slots: ['fs'] }),
      sourceType: 'git-market',
    });
    startUpdateAllBatch([marketItem({ sourceType: 'git-market' })]);
    await waitForSettledBatch();
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');

    // 批准时外部把已装换成同样带 fs 的包 → 重算后已无扩权,走普通更新分支;
    // 但市场源又以同版本改了 manifest,Main 因 expectedManifest 不匹配拒绝。
    detailMock.mockImplementation(async () => {
      installedGhosts = [
        {
          manifest: manifest({
            version: '1.0.0',
            network: { hosts: ['api.example.com'] },
            slots: ['fs'],
          }),
        },
      ];
      return {
        ...marketItem({ sourceType: 'git-market' }),
        manifest: manifest({ network: { hosts: ['api.example.com'] }, slots: ['fs'] }),
        readme: null,
      } as unknown as PluginMarketDetail;
    });
    installMock.mockRejectedValueOnce(
      Object.assign(new Error('precondition'), {
        message: 'Error invoking remote method: Error: [PRECONDITION_FAILED] manifest changed',
      }),
    );

    await approveUpdateExpansion('plugin-a');

    const row = getUpdateAllBatchState().rows?.[0];
    // 并发事实变化 → 回到重新审阅,不是终态失败(否则用户失去本项入口)。
    expect(row?.status).toBe('needs-confirm');
    expect(row?.errorText).toBeUndefined();
  });

  it('drops the stale detail when a same-release manifest swap rejects the approval', async () => {
    const reviewedManifest = manifest({ network: { hosts: ['api.example.com'] } });
    stubDetail({ manifest: reviewedManifest, sourceType: 'git-market' });
    startUpdateAllBatch([marketItem({ sourceType: 'git-market' })]);
    await waitForSettledBatch();
    expect(getUpdateAllBatchState().rows?.[0]).toMatchObject({
      status: 'needs-confirm',
      expectedManifest: reviewedManifest,
    });

    // 竞态:detail() 返回的仍是审阅时那份(所以 renderer 侧判定审阅有效),
    // 但在 install 到达 Main 之前,自定义源在**同一 releaseId 下**换了 manifest,
    // Main 因 expectedManifest 对不上拒绝。此刻手里这份 detail 已经不对了。
    const swappedManifest = manifest({
      network: { hosts: ['api.example.com', 'evil.example.com'] },
    });
    installMock.mockRejectedValueOnce(
      Object.assign(new Error('precondition'), {
        message: 'Error invoking remote method: Error: [PRECONDITION_FAILED] manifest changed',
      }),
    );

    await approveUpdateExpansion('plugin-a');

    const held = getUpdateAllBatchState().rows?.[0];
    // 旧差异与旧 manifest 必须丢弃并标记过期,否则下次批准会再提交同一份
    // 过期的 expectedManifest,循环失败。
    expect(held).toMatchObject({ status: 'needs-confirm', staleReview: true });
    expect(held?.permissionDiff).toBeUndefined();
    expect(held?.expectedManifest).toBeUndefined();

    // 再次批准:此时详情已能取到源上的新 manifest → 相对当前已装仍是扩权 →
    // 用**新** manifest 重新出确认内容。
    detailMock.mockResolvedValue({
      ...marketItem({ sourceType: 'git-market' }),
      manifest: swappedManifest,
      readme: null,
    } as unknown as PluginMarketDetail);
    await approveUpdateExpansion('plugin-a');
    const rereviewed = getUpdateAllBatchState().rows?.[0];
    expect(rereviewed).toMatchObject({ status: 'needs-confirm', staleReview: false });
    expect(rereviewed?.expectedManifest).toBe(swappedManifest);

    // 用户同意新差异 → 带新 manifest 装上,推进到完成,不再循环。
    await approveUpdateExpansion('plugin-a');
    expect(installMock).toHaveBeenLastCalledWith('plugin-a', {
      expectedReleaseId: 'release-2',
      expectedManifest: swappedManifest,
      allowPermissionExpansion: true,
      reviewedBaseline: expect.any(String),
    });
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
  });

  it('never treats a missing expectedManifest as a valid review for custom sources', async () => {
    const reviewed = manifest({ network: { hosts: ['api.example.com'] } });
    stubDetail({ manifest: reviewed, sourceType: 'git-market' });
    startUpdateAllBatch([marketItem({ sourceType: 'git-market' })]);
    await waitForSettledBatch();

    // 第一次批准被 Main 拒 → 行被清成 expectedManifest: undefined + staleReview。
    installMock.mockRejectedValueOnce(
      Object.assign(new Error('precondition'), {
        message: 'Error invoking remote method: Error: [PRECONDITION_FAILED] manifest changed',
      }),
    );
    await approveUpdateExpansion('plugin-a');
    expect(getUpdateAllBatchState().rows?.[0]?.expectedManifest).toBeUndefined();

    // 重新审阅 → 再批准,全程必须带上当前 expectedManifest。缺失被短路成
    // 「审阅仍有效」的话,这里会不带该字段安装,主进程直接 INVALID_PARAMS。
    await approveUpdateExpansion('plugin-a');
    await approveUpdateExpansion('plugin-a');

    expect(installMock).toHaveBeenLastCalledWith(
      'plugin-a',
      expect.objectContaining({ expectedManifest: reviewed }),
    );
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
  });

  it('voids an approval whose detail returned after the account switched', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 详情请求停在半空,期间切到账号 B(页面的作废 effect 还没跑,代际未变)。
    let releaseDetail: (() => void) | undefined;
    detailMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDetail = () => {
            setDataOwnerGeneration('owner-b');
            resolve({
              ...marketItem({}),
              manifest: manifest({ network: { hosts: ['api.example.com'] } }),
              readme: null,
            } as unknown as PluginMarketDetail);
          };
        }),
    );
    const approval = approveUpdateExpansion('plugin-a');
    await vi.waitFor(() => expect(releaseDetail).toBeDefined());

    // 账号 B 装着同 id 的插件:旧批准绝不能读它的 manifest、更不能装它。
    installedGhosts = [{ manifest: manifest({ version: '2.0.0' }) }];
    releaseDetail?.();
    await approval;

    expect(installMock).not.toHaveBeenCalled();
    expect(getUpdateAllBatchState().rows).toBeNull();
  });

  it('does not make a new generation approval wait behind the previous one', async () => {
    const expanding = manifest({ network: { hosts: ['api.example.com'] } });
    detailMock.mockImplementation(async (pluginId) =>
      ({
        ...marketItem({ pluginId, ghostId: pluginId === 'plugin-a' ? 'ghost-a' : 'ghost-b' }),
        manifest: expanding,
        readme: null,
      }) as unknown as PluginMarketDetail,
    );
    installedGhosts = [{ manifest: manifest({ version: '1.0.0' }) }];
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 账号 A 的批准卡在安装里(永不 resolve)。
    const stuck: Array<() => void> = [];
    installMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          stuck.push(() => resolve({ ghost: { manifest: expanding } } as never));
        }),
    );
    const oldApproval = approveUpdateExpansion('plugin-a');
    await vi.waitFor(() => expect(stuck.length).toBe(1));

    // 切账号 → 新批次(新代际)。
    setDataOwnerGeneration('owner-b');
    reconcileUpdateAllBatch();
    installedGhosts = [{ manifest: manifest({ id: 'ghost-b', version: '1.0.0' }) }];
    startUpdateAllBatch([marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' })]);
    await waitForSettledBatch();
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');

    // 新代际的批准不该排在账号 A 那个仍然卡着的安装后面:它必须立刻开跑。
    const newApproval = approveUpdateExpansion('plugin-b');
    await vi.waitFor(() => expect(stuck.length).toBe(2));

    stuck[1]?.();
    await newApproval;
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');

    // 收尾:放行旧代际那个安装,它轮到时因代际失效不会改写当前批次。
    stuck[0]?.();
    await oldApproval;
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
  });

  it('never rebinds a queued approval onto the batch that replaced it', async () => {
    const expanding = manifest({ network: { hosts: ['api.example.com'] } });
    detailMock.mockImplementation(async (pluginId) =>
      ({
        ...marketItem({ pluginId, ghostId: pluginId === 'plugin-a' ? 'ghost-a' : 'ghost-b' }),
        manifest: expanding,
        readme: null,
      }) as unknown as PluginMarketDetail,
    );
    installedGhosts = [
      { manifest: manifest({ version: '1.0.0' }) },
      { manifest: manifest({ id: 'ghost-b', version: '1.0.0' }) },
    ];
    startUpdateAllBatch([
      marketItem({}),
      marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' }),
    ]);
    await waitForSettledBatch();

    // 首项安装卡住,第二项的批准排在队列里等。
    const gate: Array<() => void> = [];
    installMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          gate.push(() => resolve({ ghost: { manifest: expanding } } as never));
        }),
    );
    const first = approveUpdateExpansion('plugin-a');
    const queued = approveUpdateExpansion('plugin-b');
    await vi.waitFor(() => expect(gate.length).toBe(1));

    // 安装进行中切换账号 + 新账号启动自己的批次(同样含 plugin-b 待确认项)。
    setDataOwnerGeneration('owner-b');
    reconcileUpdateAllBatch();
    installedGhosts = [{ manifest: manifest({ id: 'ghost-b', version: '1.0.0' }) }];
    startUpdateAllBatch([marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' })]);
    await waitForSettledBatch();
    const newBatchRow = getUpdateAllBatchState().rows?.[0];
    expect(newBatchRow).toMatchObject({ pluginId: 'plugin-b', status: 'needs-confirm' });

    const installsBeforeDrain = installMock.mock.calls.length;
    // 旧队列项这时才轮到执行:它属于上一个代际/账号,必须整体作废,
    // 绝不能改绑到新批次里同 pluginId 的待确认项上并直接安装。
    gate[0]?.();
    await first;
    await queued;

    expect(installMock.mock.calls.length).toBe(installsBeforeDrain);
    // 新批次的待确认项原封不动,仍等用户在新账号下自己批准。
    expect(getUpdateAllBatchState().rows?.[0]).toMatchObject({
      pluginId: 'plugin-b',
      status: 'needs-confirm',
    });
  });

  it('never lets a superseded runner write into the batch that replaced it', async () => {
    // 账号 A 的 detail() 停在半空。
    let releaseDetail: ((value: PluginMarketDetail) => void) | undefined;
    detailMock.mockImplementation(
      () =>
        new Promise<PluginMarketDetail>((resolve) => {
          releaseDetail = resolve;
        }),
    );
    startUpdateAllBatch([marketItem({})]);
    await vi.waitFor(() => expect(releaseDetail).toBeDefined());

    // 切到账号 B 并启动 B 自己的批次(旧批次已被作废 + 代际接管)。
    setDataOwnerGeneration('owner-b');
    reconcileUpdateAllBatch();
    expect(getUpdateAllBatchState().rows).toBeNull();
    detailMock.mockResolvedValue({
      ...marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' }),
      manifest: manifest({ id: 'ghost-b' }),
      readme: null,
    } as unknown as PluginMarketDetail);
    installedGhosts = [{ manifest: manifest({ id: 'ghost-b', version: '1.0.0' }) }];
    startUpdateAllBatch([marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' })]);

    // A 的请求这时才失败返回:不得把失败写进 B、不得消费 B 的 pending 行、
    // 不得提前清掉 B 的 running。
    releaseDetail?.(undefined as unknown as PluginMarketDetail);
    await waitForSettledBatch();

    const rows = getUpdateAllBatchState().rows ?? [];
    expect(rows.map((row) => row.pluginId)).toEqual(['plugin-b']);
    expect(rows[0]?.status).not.toBe('failed');
    expect(installMock).toHaveBeenCalledWith('plugin-b', expect.objectContaining({}));
  });

  it('settles without reinstalling once the target release is actually on record', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });
    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 目标 release 已落账:detail 报 installed,批准直接收束不重复下载。
    installedGhosts = [{ manifest: manifest({ version: '1.1.0' }) }];
    detailMock.mockResolvedValue({
      ...marketItem({ installState: 'installed' }),
      manifest: manifest({ version: '1.1.0', network: { hosts: ['api.example.com'] } }),
      readme: null,
    } as unknown as PluginMarketDetail);

    // 已落账的早退分支同样要走统一收尾:刷新市场快照 + 完成 toast,
    // 不留旧快照和悬空的未完成提示。
    const refreshMarket = vi.fn(async () => undefined);
    setUpdateAllBatchHooks({ refreshMarket });

    await approveUpdateExpansion('plugin-a');
    expect(installMock).not.toHaveBeenCalled();
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('done');
    expect(refreshMarket).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('settings.ghosts.updateAll.doneToast');
  });

  it('holds running until the post-batch refresh settles so no second batch overlaps', async () => {
    let releaseRefresh: (() => void) | undefined;
    setUpdateAllBatchHooks({
      refreshMarket: () =>
        new Promise<void>((resolve) => {
          releaseRefresh = resolve;
        }),
    });
    stubDetail({ manifest: manifest({}), sourceType: 'server' });

    startUpdateAllBatch([marketItem({})]);
    await vi.waitFor(() => expect(releaseRefresh).toBeDefined());

    // 刷新还没回来:running 必须仍为 true,旧 runner 的收尾不能让第二批插进来。
    expect(getUpdateAllBatchState().running).toBe(true);
    startUpdateAllBatch([marketItem({ pluginId: 'plugin-b', ghostId: 'ghost-b' })]);
    expect(getUpdateAllBatchState().rows?.map((row) => row.pluginId)).toEqual(['plugin-a']);

    releaseRefresh?.();
    await vi.waitFor(() => expect(getUpdateAllBatchState().running).toBe(false));
  });

  it('keeps pending confirmations readable after the page unsubscribes (unmount)', async () => {
    stubDetail({
      manifest: manifest({ network: { hosts: ['api.example.com'] } }),
      sourceType: 'server',
    });

    startUpdateAllBatch([marketItem({})]);
    await waitForSettledBatch();

    // 模块级状态与页面订阅无关:卸载(无订阅者)后快照仍保留待确认行,
    // 重新进页可以直接恢复批准/跳过入口。
    expect(getUpdateAllBatchState().rows?.[0]?.status).toBe('needs-confirm');
  });
});
