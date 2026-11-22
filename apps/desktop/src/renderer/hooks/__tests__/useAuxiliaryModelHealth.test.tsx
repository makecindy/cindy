// @vitest-environment jsdom

/**
 * 测试价值
 * - 生产入口与可观察结果：useAuxiliaryModelHealthNotice 是否弹出带「去设置」的警告提示。
 * - Bug／规则依据：docs/product-rules/auxiliary-model-health.md「弹一次」：同一个问题、同样的
 *   原因不重复弹；恢复后再出问题要再弹；副窗口不弹。
 * - 现有覆盖缺口：主进程测试只覆盖状态与通知次数，不覆盖界面去重。
 * - 最小失败输入：同一配置问题推送两次（重读两次）。
 * - tier：unit（jsdom；IPC 与推送为内存替身）。
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuxiliaryModelHealth } from '../../../shared/auxiliaryModelHealth';

const mocks = vi.hoisted(() => ({
  health: { status: 'ok' } as AuxiliaryModelHealth,
  listener: undefined as ((event: { section: string; ownerStamp: unknown }) => void) | undefined,
  secondary: false,
  toastWarning: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/secondaryWindow', () => ({ isSecondaryWindow: () => mocks.secondary }));
vi.mock('@/lib/toast', () => ({ toast: { warning: mocks.toastWarning } }));
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ isDataOwnerPushStampCurrent: () => true }));

import { resetAuxiliaryModelHealthNoticeForTests, useAuxiliaryModelHealthNotice } from '../useAuxiliaryModelHealth';

const configProblem = (issue: 'provider_disabled' | 'signed_out'): AuxiliaryModelHealth => ({
  status: 'unavailable',
  kind: 'config',
  candidates: [{ ref: 'a', label: 'A · Cindy AI', issue }],
  since: 1,
});

/** Main changes the state and announces it on the app-settings push. */
async function push(next: AuxiliaryModelHealth): Promise<void> {
  mocks.health = next;
  await act(async () => {
    mocks.listener?.({ section: 'auxiliary-model-health', ownerStamp: null });
  });
}

describe('useAuxiliaryModelHealthNotice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuxiliaryModelHealthNoticeForTests();
    mocks.health = { status: 'ok' };
    mocks.secondary = false;
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      maker: { auxiliaryModelHealthGet: vi.fn(async () => mocks.health) },
      appPreferenceControl: {
        onSettingsChanged: (listener: typeof mocks.listener) => {
          mocks.listener = listener;
          return () => { mocks.listener = undefined; };
        },
      },
    };
  });

  afterEach(() => cleanup());

  it('announces a problem once, again only for a new cause or after a recovery', async () => {
    renderHook(() => useAuxiliaryModelHealthNotice());
    await waitFor(() => expect(mocks.listener).toBeDefined());

    await push(configProblem('provider_disabled'));
    await waitFor(() => expect(mocks.toastWarning).toHaveBeenCalledTimes(1));
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'settings.auxiliaryModels.health.toast.config',
      expect.objectContaining({ action: expect.objectContaining({ label: 'settings.auxiliaryModels.health.toast.open' }) }),
    );
    mocks.toastWarning.mock.calls[0]?.[1]?.action?.onClick();
    expect(mocks.navigate).toHaveBeenCalledWith('/settings?tab=personalization&section=personalization.auxiliaryModels');

    // Same problem re-read (for example another push): silent.
    await push({ ...configProblem('provider_disabled'), since: 2 } as AuxiliaryModelHealth);
    // New cause: announced.
    await push(configProblem('signed_out'));
    // Recovery, then the first problem again: announced again.
    await push({ status: 'ok' });
    await push(configProblem('provider_disabled'));
    await waitFor(() => expect(mocks.toastWarning).toHaveBeenCalledTimes(3));
  });

  it('stays quiet in secondary windows', async () => {
    mocks.secondary = true;
    mocks.health = configProblem('provider_disabled');
    renderHook(() => useAuxiliaryModelHealthNotice());
    await waitFor(() => expect(mocks.listener).toBeDefined());
    await push(configProblem('signed_out'));
    expect(mocks.toastWarning).not.toHaveBeenCalled();
  });
});
