// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * useSplash phase 表单测(implementation-plan Step 3b WHAT3:phase 表 + 动作映射)。
 *
 * 状态机零删改约束的回归锚:envStatus→phase 映射、spawn 覆盖、fade-out 触发、
 * 三失败弹窗 booleans 与 CTA 动作语义(manifest/download=重试、spawn=前往下载,
 * useSplash.ts 现网动作映射,v6.12)。
 */

const mocks = vi.hoisted(() => ({
  envStatus: 'idle' as string,
  step: undefined as 1 | 2 | undefined,
  totalSteps: undefined as 2 | undefined,
  checkEnvironment: vi.fn(async () => undefined),
  authInitializing: false,
  coverHeld: false,
  updateErrorCode: undefined as string | undefined,
  hasPersistedSession: false,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/contexts/EnvCheckContext', () => ({
  useEnvCheck: () => ({
    status: mocks.envStatus,
    downloadProgress: 0,
    downloadInfo: { progress: 0 },
    updateVersion: undefined,
    step: mocks.step,
    totalSteps: mocks.totalSteps,
    resetSignal: 0,
    checkEnvironment: mocks.checkEnvironment,
  }),
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isInitializing: mocks.authInitializing }),
}));

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => ({ errorCode: mocks.updateErrorCode }),
}));

vi.mock('@/contexts/AppShellCoverContext', () => ({
  useAppShellCover: () => ({ coverHeld: mocks.coverHeld, reportLocalDbGate: () => {} }),
}));

import { useSplash } from '../useSplash';

describe('useSplash phase 表', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.envStatus = 'idle';
    mocks.step = undefined;
    mocks.totalSteps = undefined;
    mocks.authInitializing = false;
    mocks.coverHeld = false;
    mocks.updateErrorCode = undefined;
    mocks.hasPersistedSession = false;
    mocks.checkEnvironment.mockClear();
    (
      window as unknown as {
        electronAPI: {
          clientEndpoints: { websiteUrl: string };
          authHasPersistedSessionHintSync: () => boolean;
        };
        open: typeof window.open;
      }
    ).electronAPI = {
      clientEndpoints: { websiteUrl: 'https://cindy.example/download' },
      authHasPersistedSessionHintSync: () => mocks.hasPersistedSession,
    };
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as typeof window.matchMedia;
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it.each([
    ['checking_update', 'splash_checking_update'],
    ['updating', 'splash_updating'],
    ['update_done', 'splash_update_done'],
    ['manifest_failed', 'splash_manifest_failed'],
    ['download_failed', 'splash_download_failed'],
    ['checking', 'splash_checking'],
    ['downloading', 'splash_downloading'],
    ['passed', 'splash_passed'],
    ['failed', 'splash_failed'],
  ])('envStatus=%s → phase=%s', (envStatus, expected) => {
    mocks.envStatus = envStatus;
    const { result } = renderHook(() => useSplash());
    expect(result.current.phase).toBe(expected);
  });

  it('idle 保持 init(envStatus 未进入任何分支)', () => {
    mocks.envStatus = 'idle';
    const { result } = renderHook(() => useSplash());
    expect(result.current.phase).toBe('init');
  });

  it('spawn 覆盖:update_done + updater_spawn_failed → splash_spawn_failed(Effect 2b)', () => {
    mocks.envStatus = 'update_done';
    mocks.updateErrorCode = 'updater_spawn_failed';
    const { result } = renderHook(() => useSplash());
    expect(result.current.phase).toBe('splash_spawn_failed');
    expect(result.current.showSpawnFailedDialog).toBe(true);
  });

  it('fade-out 触发:passed ∧ 3s 地板 ∧ auth 初始化完成 → fading_out → 500ms fallback → splash_done', () => {
    mocks.envStatus = 'passed';
    const { result } = renderHook(() => useSplash());
    expect(result.current.phase).toBe('splash_passed');

    // 3s 地板前不淡出
    act(() => {
      vi.advanceTimersByTime(2_999);
    });
    expect(result.current.phase).toBe('splash_passed');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.phase).toBe('fading_out');

    // FADE_FALLBACK 500ms → splash_done(onTransitionEnd 兜底)
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.phase).toBe('splash_done');
  });

  it('已有持久会话的返回启动使用 2s 地板，仍等待真实就绪条件', () => {
    mocks.envStatus = 'passed';
    mocks.hasPersistedSession = true;
    const { result } = renderHook(() => useSplash());

    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(result.current.phase).toBe('splash_passed');

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.phase).toBe('fading_out');
    expect(result.current.isReturningSession).toBe(true);

    act(() => {
      vi.advanceTimersByTime(349);
    });
    expect(result.current.phase).toBe('fading_out');
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(result.current.phase).toBe('splash_done');
  });

  // 测试价值：生产入口 useSplash；返回启动时认证或本地数据库未就绪，用户应继续看到启动盖。
  // #7808 的 2s 地板新增返回启动分支；原有未就绪用例只走首次启动，漏掉这一时序。
  // 最小输入为已有持久会话 + passed + 单一未就绪门；unit 使用假时钟验证解除后才淡出。
  // 本文件单独运行实测 0.618s。
  it('返回启动认证未完成时，超过 2s 仍等认证完成才淡出', () => {
    mocks.envStatus = 'passed';
    mocks.hasPersistedSession = true;
    mocks.authInitializing = true;
    const { result, rerender } = renderHook(() => useSplash());
    act(() => {
      vi.advanceTimersByTime(2_001);
    });
    expect(result.current.phase).toBe('splash_passed');
    expect(result.current.isReturningSession).toBe(true);

    mocks.authInitializing = false;
    rerender();
    expect(result.current.phase).toBe('fading_out');
  });

  it('返回启动数据库未就绪时，超过 2s 仍等主界面可画才淡出', () => {
    mocks.envStatus = 'passed';
    mocks.hasPersistedSession = true;
    mocks.coverHeld = true;
    const { result, rerender } = renderHook(() => useSplash());
    act(() => {
      vi.advanceTimersByTime(2_001);
    });
    expect(result.current.phase).toBe('splash_passed');
    expect(result.current.isReturningSession).toBe(true);

    mocks.coverHeld = false;
    rerender();
    expect(result.current.phase).toBe('fading_out');
  });

  it('三失败弹窗 booleans 与 phase 一一对应且互斥', () => {
    for (const [envStatus, key] of [
      ['manifest_failed', 'showManifestFailedDialog'],
      ['download_failed', 'showDownloadFailedDialog'],
    ] as const) {
      mocks.envStatus = envStatus;
      const { result, unmount } = renderHook(() => useSplash());
      expect(result.current[key]).toBe(true);
      expect(
        [
          result.current.showManifestFailedDialog,
          result.current.showDownloadFailedDialog,
          result.current.showSpawnFailedDialog,
        ].filter(Boolean).length,
      ).toBe(1);
      unmount();
    }
  });

  it('CTA 动作语义:manifest/download 重试 → checkEnvironment;spawn →「前往下载」window.open,不触发 retry', () => {
    mocks.envStatus = 'manifest_failed';
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    const { result } = renderHook(() => useSplash());

    act(() => result.current.onRetryManifest());
    expect(mocks.checkEnvironment).toHaveBeenCalledTimes(1);

    act(() => result.current.onRetryDownload());
    expect(mocks.checkEnvironment).toHaveBeenCalledTimes(2);

    act(() => result.current.onSpawnFailedDownload());
    expect(openSpy).toHaveBeenCalledWith('https://cindy.example/download', '_blank');
    // spawn CTA 禁 retry:不得追加 checkEnvironment 调用(v6.12/v6.14)
    expect(mocks.checkEnvironment).toHaveBeenCalledTimes(2);
    openSpy.mockRestore();
  });

  it('onTipsClick 仅在 splash_failed 触发 checkEnvironment', () => {
    mocks.envStatus = 'checking';
    const { result, rerender } = renderHook(() => useSplash());
    act(() => result.current.onTipsClick());
    expect(mocks.checkEnvironment).not.toHaveBeenCalled();

    mocks.envStatus = 'failed';
    rerender();
    act(() => result.current.onTipsClick());
    expect(mocks.checkEnvironment).toHaveBeenCalledTimes(1);
  });

  it('downloading D 场景 (x/2) 标签进 tipsText(waking + suffix)', () => {
    mocks.envStatus = 'downloading';
    mocks.step = 1;
    mocks.totalSteps = 2;
    const { result } = renderHook(() => useSplash());
    expect(result.current.tipsText).toBe('splash.tips.waking(1/2)');
    expect(result.current.isDownloading).toBe(true);
  });
});
