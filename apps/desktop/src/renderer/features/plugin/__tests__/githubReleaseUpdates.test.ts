/**
 * Request budget and offered facts of the Plugin page's GitHub Release update checks.
 *
 * 测试价值
 * - 生产入口与可观察结果：ensureGithubReleaseChecks / githubReleaseUpdatesFor —— 每次打开插件页
 *   向 Main 要几次 GitHub 读取，以及横幅最终列出哪些更新。
 * - 依据：server-channel-review.md「次数、频率与并发」（页面反复进入不得反复读 GitHub）；
 *   数据归属隔离（换账号后不得沿用上个账号的检查结果）。
 * - 现有覆盖缺口：GhostSettingsWebview.test 只覆盖单个插件设置区自己的打开／重开读取，
 *   整页批量检查此前不存在。
 * - 最小失败输入：同一插件两次进入插件页（只能读一次）；先答「未登录」再登录；切换账号。
 * - tier：unit（node 环境，内存 IPC fake，无真实网络）。独立成文件：被测模块与环境都不同于
 *   updateAllController.test（jsdom + 批量控制器 mock）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing as dataOwnerTesting,
  setDataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { InstalledGhost } from '../../../../shared/ghost';
import {
  __resetGithubReleaseUpdatesForTest,
  GITHUB_RELEASE_CHECK_TTL_MS,
  checkGithubRelease,
  ensureGithubReleaseChecks,
  githubReleaseTarget,
  githubReleaseUpdatesFor,
  runGithubReleaseUpdate,
  type GithubReleaseTarget,
} from '../lib/githubReleaseUpdates';

function ghost(id: string, version = '0.1.0'): InstalledGhost {
  return {
    enabled: true,
    dir: `/plugins/_ns/local/${id}`,
    namespace: 'local',
    namespaceState: 'confirmed',
    manifest: { id, name: id, version, githubRelease: `example/${id}`, settingsHtml: 'settings.html' },
  } as InstalledGhost;
}

const available = (version: string, assetId: number) => ({
  status: 'available',
  release: { version, assetId, sha256: 'a'.repeat(64), size: 1, prerelease: false },
});

const githubRelease = vi.fn();

function targets(ghosts: InstalledGhost[]): GithubReleaseTarget[] {
  return ghosts.map((item) => githubReleaseTarget(item)!);
}

beforeEach(() => {
  __resetGithubReleaseUpdatesForTest();
  dataOwnerTesting.reset();
  setDataOwnerGeneration('owner-a');
  githubRelease.mockReset();
  vi.stubGlobal('window', { electronAPI: { ghosts: { githubRelease } } });
  vi.useFakeTimers({ toFake: ['Date'] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('GitHub Release update checks for the Plugin page', () => {
  it('reads each plugin one at a time and reuses the answer until the TTL passes', async () => {
    const ghosts = [ghost('zcode'), ghost('dsh')];
    let finishFirst!: (value: unknown) => void;
    githubRelease
      .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce({ status: 'current', release: available('0.1.0', 3).release });

    ensureGithubReleaseChecks(targets(ghosts));
    ensureGithubReleaseChecks(targets(ghosts)); // page re-render / remount while reading
    expect(githubRelease).toHaveBeenCalledTimes(1);

    finishFirst(available('0.1.1', 7));
    await vi.waitFor(() => expect(githubRelease).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(githubReleaseUpdatesFor(ghosts)).toEqual([
        { instanceId: targets(ghosts)[0]!.instanceId, ghostId: 'zcode', fromVersion: '0.1.0', version: '0.1.1', assetId: 7 },
      ]));

    ensureGithubReleaseChecks(targets(ghosts)); // reopening the page
    expect(githubRelease).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + GITHUB_RELEASE_CHECK_TTL_MS);
    githubRelease.mockResolvedValue({ status: 'current', release: available('0.1.1', 7).release });
    ensureGithubReleaseChecks(targets(ghosts));
    await vi.waitFor(() => expect(githubRelease).toHaveBeenCalledTimes(4));
  });

  it('stops queued checks when the page is no longer visible and resumes on return', async () => {
    const ghosts = [ghost('zcode'), ghost('dsh')];
    let visible = true;
    let finishFirst!: (value: unknown) => void;
    githubRelease
      .mockReturnValueOnce(new Promise((resolve) => { finishFirst = resolve; }))
      .mockResolvedValueOnce(available('0.1.1', 8));

    ensureGithubReleaseChecks(targets(ghosts), () => visible);
    visible = false;
    finishFirst(available('0.1.1', 7));
    await vi.waitFor(() => expect(githubReleaseUpdatesFor(ghosts)).toHaveLength(1));
    expect(githubRelease).toHaveBeenCalledTimes(1);

    visible = true;
    ensureGithubReleaseChecks(targets(ghosts), () => visible);
    await vi.waitFor(() => expect(githubReleaseUpdatesFor(ghosts)).toHaveLength(2));
    expect(githubRelease).toHaveBeenCalledTimes(2);
  });

  it('keeps the update offer available for retry after a failed install', async () => {
    const ghosts = [ghost('zcode')];
    const [target] = targets(ghosts);
    githubRelease.mockResolvedValueOnce(available('0.1.1', 7)).mockResolvedValueOnce({ status: 'unavailable' });
    await checkGithubRelease(target!);

    await expect(runGithubReleaseUpdate({ target: target!, assetId: 7, progressKey: 'zcode' }))
      .resolves.toEqual({ status: 'unavailable' });
    expect(githubReleaseUpdatesFor(ghosts)).toMatchObject([{ version: '0.1.1', assetId: 7 }]);
  });

  it('discards an in-flight update reply when the account changes', async () => {
    const [target] = targets([ghost('zcode')]);
    let finishUpdate!: (value: unknown) => void;
    githubRelease.mockReturnValueOnce(new Promise((resolve) => { finishUpdate = resolve; }));

    const update = runGithubReleaseUpdate({ target: target!, assetId: 7, progressKey: 'zcode' });
    setDataOwnerGeneration('owner-b');
    finishUpdate(available('0.1.2', 8));

    await expect(update).resolves.toEqual({ status: 'unavailable' });
    expect(githubRelease).toHaveBeenCalledTimes(1);
  });

  it('asks again after "sign in to GitHub" and never shows another account\'s answer', async () => {
    const ghosts = [ghost('zcode')];
    githubRelease.mockResolvedValueOnce({ status: 'sign-in' }).mockResolvedValueOnce(available('0.1.1', 7));

    ensureGithubReleaseChecks(targets(ghosts));
    expect(githubRelease).toHaveBeenCalledTimes(1);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the answer settle
    expect(githubReleaseUpdatesFor(ghosts)).toEqual([]);

    ensureGithubReleaseChecks(targets(ghosts)); // e.g. window shown again after `gh auth login`
    await vi.waitFor(() => expect(githubReleaseUpdatesFor(ghosts)).toHaveLength(1));

    setDataOwnerGeneration('owner-b');
    expect(githubReleaseUpdatesFor(ghosts)).toEqual([]);
  });
});
