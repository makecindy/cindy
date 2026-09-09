// @vitest-environment jsdom

/**
 * UpdateBanner 的重启入口判定:点入口先查「有没有任务在跑」,确认没有才直接重启,有任务
 * (或探针拿不到可信答案)就拦一次并说明「会打断进行中的任务」。探针失败刻意 fail closed
 * —— 重启会不可撤销地杀掉 in-flight turn,「无法确认」不能当成「确认没有」。
 *
 * 「有任务在跑」由哪些活动来源构成(逻辑 turn / Claude 后台活动 / Ghost card-action)是 main
 * 侧一处判定的职责,覆盖面由 main/__tests__/relaunchBusyActivity.test.ts 负责。本文件只管
 * renderer 这一侧的契约:**拿到 true 就拦、false 才走、拿不到答案就保守**。
 *
 * 另一半是**不变量:一次点击的探针结论,只有在这次点击仍然有效时才能驱动副作用**。
 * 探针在飞期间 dismiss、组件卸载、status 离开 ready 都必须让它作废 —— 三条对称路径
 * 各有一条用例,少任何一条都会漏掉「点了稍后却重启」「装回旧补丁」「confirming 残留」。
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  anyActivityBlockingRelaunch, relaunchToUpdate, openExternal, updateStatus, dismissState,
} = vi.hoisted(() => ({
  anyActivityBlockingRelaunch: vi.fn<() => Promise<boolean>>(),
  relaunchToUpdate: vi.fn(),
  openExternal: vi.fn(async () => ({ success: true })),
  updateStatus: {
    current: { status: 'ready', version: '1.2.3', errorCode: null } as {
      status: string;
      version?: string;
      errorCode: string | null;
    },
  },
  // dismissed 必须可控且由 dismiss() 真正翻转:要测「confirming 残留到下次唤回」,就得能
  // 模拟「点 X 隐藏 → 火焰按钮 restore 重新显示」这条路径,而 restore 不会卸载组件,
  // 残留的 state 正是靠它暴露出来的。
  dismissState: { dismissed: false },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/hooks/useLocale', () => ({
  useLocale: () => ({ locale: 'en', effectiveLocale: 'en', setLocale: vi.fn() }),
}));

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => updateStatus.current,
}));

vi.mock('@/hooks/useUpdateBannerDismiss', () => ({
  useUpdateBannerDismiss: () => ({
    dismissed: dismissState.dismissed,
    reason: null,
    dismiss: () => { dismissState.dismissed = true; },
    restore: () => { dismissState.dismissed = false; },
    deferBecauseBusy: vi.fn(),
    markAutoShown: vi.fn(),
    clearAutoDecision: vi.fn(),
    isDecidedFor: () => true,
    isNewUpdateAfterDismiss: () => false,
  }),
}));

// 本文件只测「点入口之后」的重启判定;自动弹出让路由 updateBannerBusyDefer 覆盖。
vi.mock('@/hooks/useDeferUpdateBannerWhileBusy', () => ({
  useDeferUpdateBannerWhileBusy: () => false,
  UPDATE_BANNER_BUSY_POLL_MS: 2000,
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

import { UpdateBanner } from '@/components/sidebar/UpdateBanner';

/** 返回一个手动 settle 的探针,用于把「点击后、resolve 前」这段窗口撑开。 */
function deferredProbe(): (busy: boolean) => void {
  let settle!: (busy: boolean) => void;
  anyActivityBlockingRelaunch.mockImplementation(
    () => new Promise<boolean>((resolve) => { settle = resolve; }),
  );
  return (busy: boolean) => settle(busy);
}

beforeEach(() => {
  anyActivityBlockingRelaunch.mockReset();
  relaunchToUpdate.mockReset();
  openExternal.mockClear();
  updateStatus.current = { status: 'ready', version: '1.2.3', errorCode: null };
  dismissState.dismissed = false;
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      anyActivityBlockingRelaunch,
      relaunchToUpdate,
      openExternal,
      clientEndpoints: { websiteUrl: 'https://cindy.ai' },
    } as unknown as Window['electronAPI'],
  });
});

afterEach(cleanup);

describe('UpdateBanner relaunch entry', () => {
  it('prompts for the VC++ Runtime, keeps the banner, and rechecks on demand', async () => {
    updateStatus.current = {
      status: 'ready',
      version: '1.2.3',
      errorCode: 'windows_vc_runtime_missing',
    };
    render(<UpdateBanner isCollapsed={false} />);

    await screen.findByText('update.windowsRuntimeMissing.title');
    expect(screen.getByText('update.windowsRuntimeMissing.description')).toBeTruthy();
    expect(anyActivityBlockingRelaunch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'update.windowsRuntimeMissing.download' }));
    expect(openExternal).toHaveBeenCalledWith(
      'https://aka.ms/vs/17/release/vc_redist.x64.exe',
    );
    await waitFor(() => {
      expect(screen.queryByText('update.windowsRuntimeMissing.title')).toBeNull();
    });

    // The downloaded patch remains ready, so the normal update entry stays
    // available and reopens the prerequisite prompt instead of probing tasks.
    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));
    await screen.findByText('update.windowsRuntimeMissing.title');
    expect(anyActivityBlockingRelaunch).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'update.windowsRuntimeMissing.retry' }));
    expect(relaunchToUpdate).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'update.windowsRuntimeMissing.later' }));
    await waitFor(() => {
      expect(screen.queryByText('update.windowsRuntimeMissing.title')).toBeNull();
    });
    expect(screen.getByRole('button', { name: 'update.banner.ariaExpanded' })).toBeTruthy();
  });

  it('warns about the interruption instead of relaunching when main reports live activity', async () => {
    anyActivityBlockingRelaunch.mockResolvedValue(true);
    render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));

    const hint = await screen.findByText('update.banner.confirmBusyHint');
    expect(anyActivityBlockingRelaunch).toHaveBeenCalledTimes(1);
    expect(hint.className).toContain('text-[var(--warning-fg)]');
    // 拦住的这一步不能顺手把 app 重启了 —— 是否打断任务由用户拍板。
    expect(relaunchToUpdate).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.confirmAria' }));
    expect(relaunchToUpdate).toHaveBeenCalledTimes(1);
  });

  it('relaunches on the first click when main reports nothing running', async () => {
    anyActivityBlockingRelaunch.mockResolvedValue(false);
    render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));

    await waitFor(() => expect(relaunchToUpdate).toHaveBeenCalledTimes(1));
    expect(anyActivityBlockingRelaunch).toHaveBeenCalledTimes(1);
    // 没有任务在跑时不该再出现第二步 —— 那句「应用会自动重启」不带任何信息量。
    expect(screen.queryByRole('button', { name: 'update.banner.confirmAria' })).toBeNull();
    expect(screen.queryByText('update.banner.confirmBusyHint')).toBeNull();
  });

  // 探针拿不到可信答案时 fail closed:「无法确认」不能当成「确认没有」,重启会不可撤销地
  // 杀掉 in-flight turn。口径同 main 侧托盘退出路径的 hasActiveTurn(catch → true)。
  it('falls back to the warning state when the busy probe throws synchronously', async () => {
    anyActivityBlockingRelaunch.mockImplementation(() => {
      throw new Error('electron bridge is not registered');
    });
    render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));

    await screen.findByText('update.banner.confirmBusyHint');
    expect(relaunchToUpdate).not.toHaveBeenCalled();
  });

  it('falls back to the warning state when the busy probe rejects', async () => {
    anyActivityBlockingRelaunch.mockRejectedValue(new Error('ipc channel closed'));
    render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));

    await screen.findByText('update.banner.confirmBusyHint');
    expect(relaunchToUpdate).not.toHaveBeenCalled();
  });

  it('ignores repeat clicks while the busy probe is still in flight', async () => {
    const settle = deferredProbe();
    render(<UpdateBanner isCollapsed={false} />);

    const entry = screen.getByRole('button', { name: 'update.banner.ariaExpanded' });
    fireEvent.click(entry);
    fireEvent.click(entry);
    fireEvent.click(entry);

    await waitFor(() => expect(anyActivityBlockingRelaunch).toHaveBeenCalledTimes(1));
    expect(relaunchToUpdate).not.toHaveBeenCalled();

    settle(false);
    await waitFor(() => expect(relaunchToUpdate).toHaveBeenCalledTimes(1));
  });

  it('applies the same judgement to the collapsed / rail entry', async () => {
    anyActivityBlockingRelaunch.mockResolvedValue(false);
    const { unmount } = render(<UpdateBanner isCollapsed />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaCollapsed' }));
    await waitFor(() => expect(relaunchToUpdate).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'update.banner.confirmAria' })).toBeNull();

    unmount();
    relaunchToUpdate.mockClear();
    anyActivityBlockingRelaunch.mockResolvedValue(true);
    render(<UpdateBanner isCollapsed />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaCollapsed' }));
    // 收起态没有文案位置,拦下来的形态是 ✓ / ✕ 两键。
    await screen.findByRole('button', { name: 'update.banner.confirmAria' });
    expect(screen.getByRole('button', { name: 'update.banner.cancelAria' })).toBeTruthy();
    expect(relaunchToUpdate).not.toHaveBeenCalled();
  });

  // ── 不变量:探针结论只在这次点击仍然有效时才生效 ──
  // 三条路径都会在探针在飞期间让点击失效,少任何一条都是一个真实缺陷。

  it('discards the probe when the user dismisses the banner while it is in flight', async () => {
    const settle = deferredProbe();
    const { rerender } = render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));
    await waitFor(() => expect(anyActivityBlockingRelaunch).toHaveBeenCalledTimes(1));

    // 用户点「稍后再说」= 明确表达现在不要重启。
    fireEvent.click(screen.getByRole('button', { name: 'update.banner.dismissAria' }));
    rerender(<UpdateBanner isCollapsed={false} />);
    settle(false);

    // 给 continuation 足够的微任务窗口跑完,再断言它什么都没做。
    await Promise.resolve();
    await Promise.resolve();
    expect(relaunchToUpdate).not.toHaveBeenCalled();
  });

  it('leaves no confirming state behind when dismissed mid-probe with a busy result', async () => {
    const settle = deferredProbe();
    const { rerender } = render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));
    await waitFor(() => expect(anyActivityBlockingRelaunch).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.dismissAria' }));
    rerender(<UpdateBanner isCollapsed={false} />);
    expect(screen.queryByRole('button', { name: 'update.banner.ariaExpanded' })).toBeNull();

    settle(true);
    await Promise.resolve();
    await Promise.resolve();

    // 火焰按钮唤回(restore 不卸载组件,残留的 state 会原样显示出来)。confirming 若被
    // 那个已作废的探针置位,用户没再点过入口就会直接落在第二步。
    dismissState.dismissed = false;
    rerender(<UpdateBanner isCollapsed={false} />);

    expect(screen.getByRole('button', { name: 'update.banner.ariaExpanded' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'update.banner.confirmAria' })).toBeNull();
    expect(relaunchToUpdate).not.toHaveBeenCalled();
  });

  it('discards the probe when the ready patch gets superseded while it is in flight', async () => {
    const settle = deferredProbe();
    const { rerender } = render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));
    await waitFor(() => expect(anyActivityBlockingRelaunch).toHaveBeenCalledTimes(1));

    // 新版本下载完成,已就绪补丁被顶掉:此时重启会装回旧补丁。
    updateStatus.current = { status: 'superseding', version: '1.2.3', errorCode: null };
    rerender(<UpdateBanner isCollapsed={false} />);
    settle(false);

    await Promise.resolve();
    await Promise.resolve();
    expect(relaunchToUpdate).not.toHaveBeenCalled();
    // superseding 态本身仍正常渲染(准备中),不该被这次作废影响。
    expect(screen.getByText('update.banner.preparingButton')).toBeTruthy();
  });

  it('discards the probe when the component unmounts while it is in flight', async () => {
    const settle = deferredProbe();
    const { unmount } = render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));
    await waitFor(() => expect(anyActivityBlockingRelaunch).toHaveBeenCalledTimes(1));

    unmount();
    settle(false);

    await Promise.resolve();
    await Promise.resolve();
    expect(relaunchToUpdate).not.toHaveBeenCalled();
  });
});
