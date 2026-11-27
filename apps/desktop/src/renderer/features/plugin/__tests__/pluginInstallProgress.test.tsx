/**
 * 测试价值
 * - 生产入口与可观察结果：「全部更新」弹窗的行状态 + 窗口级更新进度（pluginInstallProgress）。
 *   用户看到正在更新的那一行依次显示各步骤、失败原因留在原处、完成后计数加一。
 * - Bug／规则依据：verified-downloads.md「下载进度与界面」——插件更新此前只有转圈，更新中途
 *   发生了什么完全不可见。
 * - 现有覆盖缺口：updateAllController / updateAllModel 的用例只断言行状态迁移，不渲染弹窗，
 *   也不涉及 Main 推来的进度。
 * - 最小失败输入：一行 installing + 一次进度推送；一次未由本窗口发起的推送；失败后重试；取消；
 *   完成的推送尚未到达时发起方已标记成功；切换账号后旧进度与旧身份迟到的推送（PR #11305 评审：
 *   插件页切换身份时不卸载，进度只按 pluginId 记录）；失败原因在主进程失败推送之后仍保留。
 * - tier：unit（jsdom，渲染真实弹窗，fake timers 控制完成后的停留）。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key}(${Object.values(values).join('|')})` : key,
    i18n: { language: 'en' },
  }),
}));

import { __testing as dataOwnerTesting, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { initialDownloadProgress, type DownloadProgress } from '../../../../shared/downloadProgress';
import type { PluginMarketInstallProgress } from '../../../../shared/pluginMarket';
import {
  __resetPluginInstallProgressForTest,
  beginPluginInstallProgress,
  dropStalePluginInstallProgress,
  endPluginInstallProgress,
  failPluginInstallProgress,
  PLUGIN_INSTALL_DONE_HOLD_MS,
  succeedPluginInstallProgress,
} from '../lib/pluginInstallProgress';
import type { UpdateAllRow } from '../lib/updateAllModel';
import { UpdateAllDialog } from '../UpdateAllDialog';

let push: ((event: PluginMarketInstallProgress, ownerStamp?: unknown) => void) | null = null;
const stopListening = vi.fn(() => {
  push = null;
});

function row(patch: Partial<UpdateAllRow> = {}): UpdateAllRow {
  return {
    pluginId: 'plugin-a',
    ghostId: 'ghost-a',
    name: 'Helper',
    fromVersion: '1.0.0',
    toVersion: '1.1.0',
    status: 'installing',
    ...patch,
  };
}
function show(rows: UpdateAllRow[]) {
  return render(<UpdateAllDialog open rows={rows} iconByGhostId={new Map()} onClose={() => undefined} />);
}
function step(
  pluginId: string,
  download: Partial<DownloadProgress>,
  awaitingConsent = false,
  ownerStamp?: { dataOwnerId: string | null; ownerGeneration: number },
) {
  act(() =>
    push?.(
      {
        pluginId,
        download: { ...initialDownloadProgress('downloading', 100), ...download },
        ...(awaitingConsent ? { awaitingConsent: true as const } : {}),
      },
      ownerStamp,
    ),
  );
}
const ringOf = (name: string) => screen.queryByRole('progressbar', { name });

beforeEach(() => {
  vi.useFakeTimers();
  dataOwnerTesting.reset();
  __resetPluginInstallProgressForTest();
  stopListening.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pluginMarket: {
      onInstallProgress: (listener: (event: PluginMarketInstallProgress, ownerStamp?: unknown) => void) => {
        push = listener;
        return stopListening;
      },
    },
  };
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('plugin update progress in the update-all dialog', () => {
  it('shows the step of the row being updated, including the wait for a permission confirmation', () => {
    act(() => beginPluginInstallProgress('plugin-a'));
    show([row(), row({ pluginId: 'plugin-b', name: 'Other', status: 'pending' })]);

    expect(ringOf('Helper')?.textContent).toBe('downloadProgress.phase.preparing');
    step('plugin-a', { loaded: 40, percent: 40 });
    expect(ringOf('Helper')?.textContent).toBe('downloadProgress.phase.downloading');
    step('plugin-a', { phase: 'verifying', loaded: 100, percent: 100 }, true);
    expect(ringOf('Helper')?.textContent).toBe('settings.ghosts.installProgress.awaitingConsent');
    // Rows that are not running keep their plain status; pushes nobody began here are ignored.
    step('plugin-b', { loaded: 10, percent: 10 });
    expect(ringOf('Other')).toBeNull();
    expect(screen.getByText('settings.ghosts.updateAll.statusPending')).toBeTruthy();
  });

  it('keeps a failed row marked with its reason until the next attempt', () => {
    act(() => beginPluginInstallProgress('plugin-a'));
    step('plugin-a', { loaded: 61, percent: 61 });
    act(() => {
      failPluginInstallProgress('plugin-a');
      endPluginInstallProgress('plugin-a');
    });
    show([row({ status: 'failed', errorText: 'Download timed out' })]);

    expect(ringOf('Helper')?.textContent).toBe('Download timed out');
    expect(ringOf('Helper')?.getAttribute('aria-valuenow')).toBe('61');

    // Retrying starts over from "preparing"; the old reason is gone.
    act(() => beginPluginInstallProgress('plugin-a'));
    expect(ringOf('Helper')?.textContent).toBe('downloadProgress.phase.preparing');
  });

  it('drops a declined update at once and a finished one after a short hold, then stops listening', () => {
    act(() => beginPluginInstallProgress('plugin-a'));
    act(() => beginPluginInstallProgress('plugin-b'));
    show([row(), row({ pluginId: 'plugin-b', name: 'Other' })]);

    step('plugin-b', { phase: 'cancelled' });
    expect(ringOf('Other')).toBeNull();

    // Success is marked by the runner, even if Main's last push has not arrived yet.
    step('plugin-a', { phase: 'installing', loaded: 100, percent: 100 });
    act(() => {
      succeedPluginInstallProgress('plugin-a');
      endPluginInstallProgress('plugin-a');
    });
    expect(ringOf('Helper')?.textContent).toBe('settings.ghosts.updateAll.statusDone');
    expect(stopListening).not.toHaveBeenCalled();
    act(() => void vi.advanceTimersByTime(PLUGIN_INSTALL_DONE_HOLD_MS));
    expect(ringOf('Helper')).toBeNull();
    expect(stopListening).toHaveBeenCalledTimes(1);
  });

  it('drops the previous owner\'s progress and ignores its late pushes', () => {
    setDataOwnerGeneration('owner-a', 1);
    act(() => beginPluginInstallProgress('plugin-a'));
    show([row()]);
    step('plugin-a', { loaded: 40, percent: 40 }, false, { dataOwnerId: 'owner-a', ownerGeneration: 1 });
    expect(ringOf('Helper')?.textContent).toBe('downloadProgress.phase.downloading');

    // The page stays mounted across the switch: the old ring goes, the row falls back to its status.
    act(() => {
      setDataOwnerGeneration('owner-b', 2);
      dropStalePluginInstallProgress();
    });
    expect(ringOf('Helper')).toBeNull();

    // The new owner starts the same plugin; the old install's push must not move its ring.
    act(() => beginPluginInstallProgress('plugin-a'));
    step('plugin-a', { phase: 'failed' }, false, { dataOwnerId: 'owner-a', ownerGeneration: 1 });
    expect(ringOf('Helper')?.textContent).toBe('downloadProgress.phase.preparing');
    step('plugin-a', { loaded: 10, percent: 10 }, false, { dataOwnerId: 'owner-b', ownerGeneration: 2 });
    expect(ringOf('Helper')?.textContent).toBe('downloadProgress.phase.downloading');
  });

  it('keeps the runner\'s failure reason when Main\'s failure push arrives afterwards', () => {
    act(() => {
      beginPluginInstallProgress('plugin-a');
      failPluginInstallProgress('plugin-a', 'Download timed out');
    });
    step('plugin-a', { phase: 'failed', loaded: 61, percent: 61 });
    // A row without its own text still shows the recorded reason in the dialog.
    show([row({ status: 'failed' })]);
    expect(ringOf('Helper')?.textContent).toBe('settings.ghosts.updateAll.statusFailed');
    expect(ringOf('Helper')?.getAttribute('aria-valuetext')).toContain('Download timed out');
  });

  it('counts the rows already updated', () => {
    show([row({ status: 'done' }), row({ pluginId: 'plugin-b', name: 'Other', status: 'pending' })]);
    expect(screen.getByText('settings.ghosts.updateAll.progressCount(1|2)')).toBeTruthy();
  });
});
