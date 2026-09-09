// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * LoginHandoff 衔接动画测试(implementation-plan Step 3b WHAT2/WHAT3)。
 *
 * - fake-timer 时序:settle 0.3s → shift 650ms → panel 420ms 上滑 20px →
 *   slogan +100ms/500ms(demo splashHandoff() 时间轴逐项对照;Slogan 最后出现);
 * - 冷启动每次播放、resize/reset 不重播、卸载清理;reduced-motion 直落终态;
 * - 两条冷启动集成(real AuthProvider + resolved snapshot,集成层禁 mock-reject
 *   ——异常路径由 AuthContext catch 归一为 resolved-unauthenticated,单测另测):
 *   unauthenticated = 完整播放;authenticated = 品牌淡出直入主界面不闪登录面板。
 */

const svc = vi.hoisted(() => ({
  // onAuthStateChange 捕获 listener,供集成测试模拟「登出推送」(auth:state-change)
  authListener: null as ((state: unknown) => void) | null,
  service: {
    initialize: vi.fn<() => Promise<unknown>>(),
    onAuthStateChange: vi.fn(),
    dispose: vi.fn(),
    getLoginState: vi.fn(async () => ({ ok: true, state: null })),
    dispatchLoginAction: vi.fn(async () => ({ ok: true, state: null })),
    logout: vi.fn(async () => {}),
  },
  loginHook: {
    isLoading: false,
    errorCode: null as string | null,
    loginState: {
      step: 'identifier',
      providers: { email: true, phone: true, attribution: 'email', social: [] },
    } as unknown,
    dispatch: vi.fn(async () => true),
    clearError: vi.fn(),
  },
  env: { status: 'passed' as string },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/authService', () => ({ createAuthService: () => svc.service }));
vi.mock('@/lib/makerChatStore', () => ({
  cancelRemoteOptimisticSendsForDataOwnerBoundary: vi.fn(),
  setCurrentUserName: vi.fn(),
}));
vi.mock('@/lib/sessionsStore', () => ({ sessionsStore: { reset: vi.fn() } }));
vi.mock('@/features/cc-agent/hooks/useWorkers', () => ({ clearWorkersCache: vi.fn() }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => {}) }),
}));
vi.mock('@/hooks/useLogin', () => ({ useLogin: () => svc.loginHook }));
vi.mock('@/components/title-bar/WindowControls', () => ({ WindowControls: () => null }));
vi.mock('@/contexts/EnvCheckContext', () => ({
  useEnvCheck: () => ({
    status: svc.env.status,
    downloadProgress: 0,
    downloadInfo: { progress: 0 },
    updateVersion: undefined,
    step: undefined,
    totalSteps: undefined,
    resetSignal: 0,
    checkEnvironment: vi.fn(async () => {}),
  }),
}));
vi.mock('@/hooks/useUpdateStatus', () => ({ useUpdateStatus: () => ({ errorCode: undefined }) }));

import {
  LOGIN_HANDOFF_TIMINGS,
  LoginHandoffProvider,
  useLoginHandoff,
  type LoginHandoffContextValue,
} from '../LoginHandoffContext';
import { AuthProvider, useAuth } from '../AuthContext';
import { LoginBrandStage } from '@/components/login/LoginBrandStage';
import { SplashScreen } from '@/components/splash/SplashScreen';
import { LoginPage } from '@/components/login/LoginPage';
import {
  brandPlacement,
  panelPlacement,
  splashBrandPlacement,
} from '@/components/login/loginScale';
import '@/themes/colors';
import { colorRegistry } from '@/themes/color-registry';

/* ── 探针:抓取 context 值供命令式驱动 ── */
const probe: { current: LoginHandoffContextValue | null } = { current: null };
function Probe() {
  probe.current = useLoginHandoff();
  return <div data-testid="handoff-phase">{probe.current.phase}</div>;
}

function setReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('prefers-reduced-motion') ? matches : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  vi.useFakeTimers();
  setReducedMotion(false);
  probe.current = null;
  svc.env.status = 'passed';
  svc.loginHook.loginState = {
    step: 'identifier',
    providers: { email: true, phone: true, attribution: 'email', social: [] },
  };
  svc.authListener = null;
  svc.service.initialize.mockReset();
  svc.service.onAuthStateChange.mockReset();
  svc.service.onAuthStateChange.mockImplementation((cb: (state: unknown) => void) => {
    svc.authListener = cb;
    return () => {};
  });
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'darwin',
    onAuthSessionExpired: () => () => {},
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const T = LOGIN_HANDOFF_TIMINGS;

function fireAnchors({ splashComplete = true }: { splashComplete?: boolean } = {}) {
  act(() => {
    probe.current!.reportBrandAssetsReady();
    probe.current!.reportSplashExited();
    if (splashComplete) probe.current!.reportSplashExitCompleted();
  });
}

describe('LoginHandoff 时序(fake-timer)', () => {
  it('settle 0.3s→shift 650ms→panel 420ms 上滑→slogan +100ms/500ms,Slogan 最后出现(demo splashHandoff 对照)', () => {
    render(
      <LoginHandoffProvider authResolved authenticated={false}>
        <Probe />
      </LoginHandoffProvider>,
    );
    expect(probe.current!.phase).toBe('boot');
    expect(probe.current!.brandLayout).toBe('splash');
    // 面板先挂载(未登录冷启动 LoginPage 在 env passed 后即挂,handoff 前不显示)
    act(() => probe.current!.reportLoginPanelMounted());
    expect(probe.current!.panelRevealed).toBe(false);

    fireAnchors();
    expect(probe.current!.phase).toBe('settle');
    // Handoff timing starts with Splash fading, but the composition stays
    // frozen until Splash reports that the fade has completed.
    expect(probe.current!.brandLayout).toBe('splash');
    expect(probe.current!.panelRevealed).toBe(false);
    expect(probe.current!.sloganRevealed).toBe(false);

    act(() => vi.advanceTimersByTime(T.settleMs - 1));
    expect(probe.current!.phase).toBe('settle');
    act(() => vi.advanceTimersByTime(1));
    expect(probe.current!.phase).toBe('shift');

    act(() => vi.advanceTimersByTime(T.shiftMs - 1));
    expect(probe.current!.phase).toBe('shift');
    act(() => vi.advanceTimersByTime(1));
    // t=950ms:面板入场(420ms cubic-bezier(.35,.1,.25,1) 由消费端 style 承载)
    expect(probe.current!.phase).toBe('panel');
    expect(probe.current!.panelRevealed).toBe(true);
    expect(probe.current!.sloganRevealed).toBe(false); // Slogan 尚未出现

    act(() => vi.advanceTimersByTime(T.sloganDelayMs - 1));
    expect(probe.current!.phase).toBe('panel');
    act(() => vi.advanceTimersByTime(1));
    expect(probe.current!.phase).toBe('slogan');
    expect(probe.current!.sloganRevealed).toBe(true); // Slogan 最后出现

    act(() => vi.advanceTimersByTime(T.sloganMs + T.doneBufferMs - 1));
    expect(probe.current!.phase).toBe('slogan');
    act(() => vi.advanceTimersByTime(1));
    expect(probe.current!.phase).toBe('done');
    expect(probe.current!.isPlaying).toBe(false);
    // 时序常量本体锚定(demo 逐字):300/650/420/100/500 + 三条 easing
    expect(T.settleMs).toBe(300);
    expect(T.shiftMs).toBe(650);
    expect(T.panelMs).toBe(420);
    expect(T.panelRisePx).toBe(20);
    expect(T.sloganDelayMs).toBe(100);
    expect(T.sloganMs).toBe(500);
    expect(T.shiftEasing).toBe('cubic-bezier(.33,0,.18,1)');
    expect(T.panelEasing).toBe('cubic-bezier(.35,.1,.25,1)');
    expect(T.sloganEasing).toBe('cubic-bezier(.55,.06,.38,.96)');
  });

  it('未登录另需「面板已挂载」信号才进 panel 步(awaiting-panel 门)', () => {
    render(
      <LoginHandoffProvider authResolved authenticated={false}>
        <Probe />
      </LoginHandoffProvider>,
    );
    fireAnchors();
    act(() => vi.advanceTimersByTime(T.settleMs + T.shiftMs));
    expect(probe.current!.phase).toBe('awaiting-panel');
    expect(probe.current!.panelRevealed).toBe(false);

    act(() => probe.current!.reportLoginPanelMounted());
    expect(probe.current!.phase).toBe('panel');
  });

  it('冷启动每次播放但不重播:done 后重发锚/信号 phase 恒 done、无残留 timer', () => {
    render(
      <LoginHandoffProvider authResolved authenticated={false}>
        <Probe />
      </LoginHandoffProvider>,
    );
    act(() => probe.current!.reportLoginPanelMounted());
    fireAnchors();
    // phase 链每步在 effect 内续排 timer,分轮跑空直至收敛
    for (let round = 0; round < 4; round += 1) act(() => vi.runAllTimers());
    expect(probe.current!.phase).toBe('done');

    // 模拟 resize/reset 后各类信号重放:不重播
    fireAnchors();
    act(() => {
      probe.current!.reportLoginPanelUnmounted();
      probe.current!.reportLoginPanelMounted();
    });
    for (let round = 0; round < 4; round += 1) act(() => vi.runAllTimers());
    expect(probe.current!.phase).toBe('done');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('卸载清理:播放中途 unmount 清空全部在途 timer', () => {
    const view = render(
      <LoginHandoffProvider authResolved authenticated={false}>
        <Probe />
      </LoginHandoffProvider>,
    );
    fireAnchors();
    expect(probe.current!.phase).toBe('settle');
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('prefers-reduced-motion: reduce 直落终态(无位移/无渐入过程)', () => {
    setReducedMotion(true);
    render(
      <LoginHandoffProvider authResolved authenticated={false}>
        <Probe />
      </LoginHandoffProvider>,
    );
    fireAnchors();
    // 不经 settle/shift/panel/slogan,直接 done;面板与 Slogan 即刻可见
    expect(probe.current!.phase).toBe('done');
    expect(probe.current!.panelRevealed).toBe(true);
    expect(probe.current!.sloganRevealed).toBe(true);
    expect(probe.current!.isPlaying).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reduced-motion 下 Splash 延迟卸载仍冻结布局,完成后才落终态', () => {
    setReducedMotion(true);
    render(
      <LoginHandoffProvider authResolved authenticated={false}>
        <LoginBrandStage />
        <Probe />
      </LoginHandoffProvider>,
    );
    act(() => probe.current!.reportLoginPanelMounted());
    fireAnchors({ splashComplete: false });

    expect(probe.current!.phase).toBe('awaiting-splash-exit');
    expect(probe.current!.brandLayout).toBe('splash');
    expect(probe.current!.panelRevealed).toBe(false);
    expect(probe.current!.isPlaying).toBe(true);

    act(() => vi.runAllTimers());
    expect(probe.current!.phase).toBe('awaiting-splash-exit');

    act(() => probe.current!.reportSplashExitCompleted());
    expect(probe.current!.phase).toBe('done');
    expect(probe.current!.brandLayout).toBe('login');
    expect(probe.current!.panelRevealed).toBe(true);
    expect(probe.current!.sloganRevealed).toBe(true);
    expect(probe.current!.isPlaying).toBe(false);
    expect(screen.getByTestId('login-brand-canvas').style.transition).toBe('');
  });

  it('reduced-motion 下品牌布局切换不挂 transform transition', () => {
    setReducedMotion(true);
    render(
      <LoginHandoffProvider authResolved authenticated={false}>
        <LoginBrandStage />
        <Probe />
      </LoginHandoffProvider>,
    );
    act(() => probe.current!.reportLoginPanelMounted());
    fireAnchors();
    act(() => probe.current!.reportSplashExitCompleted());

    expect(probe.current!.phase).toBe('done');
    expect(probe.current!.brandLayout).toBe('login');
    expect(screen.getByTestId('login-brand-canvas').style.transition).toBe('');
  });

  it('已登录分支没有登录面板,始终保持 Splash 构图且不使用 footer 预留', () => {
    render(
      <LoginHandoffProvider authResolved authenticated coverHeld>
        <LoginBrandStage />
        <Probe />
      </LoginHandoffProvider>,
    );
    act(() => {
      probe.current!.reportBrandAssetsReady();
      probe.current!.reportSplashExited();
      probe.current!.reportSplashExitCompleted();
    });
    expect(probe.current!.branch).toBe('authenticated');
    expect(probe.current!.brandLayout).toBe('splash');
    const splash = splashBrandPlacement(window.innerWidth, window.innerHeight);
    expect(screen.getByTestId('login-brand-canvas').style.transform).toBe(
      `translate(-50%, calc(-50% + ${splash.translateY}px)) scale(${splash.scale})`,
    );
    expect(screen.getByTestId('login-brand-canvas').style.transition).toBe('');

    act(() => vi.advanceTimersByTime(LOGIN_HANDOFF_TIMINGS.brandExitMs));
    expect(probe.current!.phase).toBe('done');
    expect(probe.current!.brandLayout).toBe('splash');
    expect(screen.getByTestId('login-brand-canvas').style.transform).toBe(
      `translate(-50%, calc(-50% + ${splash.translateY}px)) scale(${splash.scale})`,
    );
  });

  it('登录面板与品牌层通过 context 共享同一 bottom reserve', () => {
    render(
      <LoginHandoffProvider authResolved authenticated={false}>
        <Probe />
      </LoginHandoffProvider>,
    );
    expect(probe.current!.panelBottomReserve).toBeNull();
    act(() => probe.current!.reportPanelBottomReserve(124));
    expect(probe.current!.panelBottomReserve).toBe(124);
    act(() => probe.current!.reportPanelBottomReserve(0));
    expect(probe.current!.panelBottomReserve).toBe(0);
    act(() => probe.current!.reportPanelBottomReserve(null));
    expect(probe.current!.panelBottomReserve).toBeNull();
  });

  it('Splash 退场及 shift 期间锁定 Splash 布局,面板显示时才切到登录布局', () => {
    render(
      <LoginHandoffProvider authResolved authenticated={false}>
        <Probe />
      </LoginHandoffProvider>,
    );
    act(() => probe.current!.reportLoginPanelMounted());
    fireAnchors();
    expect(probe.current!.phase).toBe('settle');
    expect(probe.current!.brandLayout).toBe('splash');

    act(() => probe.current!.reportSplashExitCompleted());
    expect(probe.current!.brandLayout).toBe('splash');

    act(() => vi.advanceTimersByTime(T.settleMs + T.shiftMs));
    expect(probe.current!.phase).toBe('panel');
    expect(probe.current!.brandLayout).toBe('login');
  });

  it('Splash 延迟卸载时冻结在 Splash 布局,实际卸载后才进入 panel', () => {
    render(
      <LoginHandoffProvider authResolved authenticated={false}>
        <Probe />
      </LoginHandoffProvider>,
    );
    act(() => probe.current!.reportLoginPanelMounted());
    fireAnchors({ splashComplete: false });

    act(() => vi.advanceTimersByTime(T.settleMs + T.shiftMs));
    expect(probe.current!.phase).toBe('awaiting-splash-exit');
    expect(probe.current!.brandLayout).toBe('splash');
    expect(probe.current!.panelRevealed).toBe(false);
    expect(probe.current!.isPlaying).toBe(true);

    act(() => vi.runAllTimers());
    expect(probe.current!.phase).toBe('awaiting-splash-exit');

    act(() => probe.current!.reportSplashExitCompleted());
    expect(probe.current!.phase).toBe('panel');
    expect(probe.current!.brandLayout).toBe('login');
    expect(probe.current!.panelRevealed).toBe(true);
  });
});

/* ── 冷启动集成(real AuthProvider + LoginBrandStage + SplashScreen + LoginPage) ── */

function HandoffHost({ children }: { children: React.ReactNode }) {
  const { isInitializing, isAuthenticated, canEnterApp } = useAuth();
  return (
    <LoginHandoffProvider
      authResolved={!isInitializing}
      authenticated={isAuthenticated || canEnterApp}
    >
      {children}
    </LoginHandoffProvider>
  );
}

/** GuestRoute 等价物:auth 未决/已登录不挂 LoginPage(路由层职责的测试内投影)。 */
function GuestGate() {
  const { isInitializing, isAuthenticated } = useAuth();
  if (isInitializing || isAuthenticated) return null;
  return <LoginPage />;
}

function renderColdStart() {
  return render(
    <AuthProvider>
      <HandoffHost>
        <LoginBrandStage />
        <SplashScreen />
        <GuestGate />
        <Probe />
      </HandoffHost>
    </AuthProvider>,
  );
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function loadBrandAssets() {
  fireEvent.load(screen.getByTestId('login-brand-hero'));
  fireEvent.load(screen.getByTestId('login-brand-wordmark'));
  fireEvent.load(screen.getByTestId('login-slogan'));
}

describe('冷启动集成(resolved snapshot,禁 mock-reject)', () => {
  it('browser-redirect 无 footer 时，面板与品牌层统一使用 0 bottom reserve', async () => {
    svc.loginHook.loginState = { step: 'browser-redirect', label: 'Google' };
    svc.service.initialize.mockResolvedValue({
      isAuthenticated: false,
      isCanary: false,
      deviceId: 'test-device',
      user: null,
    });
    renderColdStart();
    await flush();

    expect(probe.current!.panelBottomReserve).toBe(0);
    expect(screen.queryByTestId('login-stage-footer')).toBeNull();

    const panel = panelPlacement(window.innerWidth, window.innerHeight, 1229, 0);
    expect(screen.getByTestId('login-stage').style.top).toBe(`${panel.topY}px`);

    const brand = splashBrandPlacement(window.innerWidth, window.innerHeight);
    expect(screen.getByTestId('login-brand-canvas').style.transform).toBe(
      `translate(-50%, calc(-50% + ${brand.translateY}px)) scale(${brand.scale})`,
    );
    expect(probe.current!.brandLayout).toBe('splash');
  });

  it('unauthenticated 冷启动:品牌屏→完整衔接播放;全程单一品牌 DOM/最多一个可见 panel/done 后可点击/overlay 不拦截', async () => {
    // 集成层异常路径口径 = resolved-unauthenticated snapshot(v6.8 消歧)
    svc.service.initialize.mockResolvedValue({
      isAuthenticated: false,
      isCanary: false,
      deviceId: 'test-device',
      user: null,
    });
    renderColdStart();
    await flush();

    // ── 冷启动品牌屏(demo desktop-splash 相):品牌可见、Slogan 未出现、
    //    Splash 统一面板在场、登录面板隐藏 ──
    expect(screen.getAllByTestId('login-stage-root').length).toBe(1);
    const hero = screen.getByTestId('login-brand-hero');
    expect(hero.style.left).toBe('443px'); // wave4 品牌位 = 登录位(379:5xx 实测)
    expect(hero.style.top).toBe('275px');
    expect(screen.getByTestId('login-slogan').style.opacity).toBe('0');
    expect(screen.getByTestId('splash-panel')).toBeTruthy();
    const group = screen.getByTestId('login-group');
    expect(group.style.opacity).toBe('0'); // splash 期登录面板不可见 → 最多一个可见 panel
    expect(group.style.pointerEvents).toBe('none');
    // 单一品牌 DOM:LoginPage 面板宿主层内不含任何品牌图(所有权契约)
    const panelHost = screen.getByTestId('login-panel-stage-root');
    expect(
      panelHost.querySelectorAll('img[src*="hero"], img[src*="wordmark"], img[src*="slogan"]')
        .length,
    ).toBe(0);
    // overlay 不拦截 hit-test
    expect(screen.getByTestId('login-stage-root').className).toContain('pointer-events-none');

    // ── 品牌资产 onload(推进锚) + 3s 地板后 Splash 退场 → 起播 ──
    loadBrandAssets();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(probe.current!.phase).toBe('settle');
    expect(probe.current!.branch).toBe('unauthenticated');
    expect(probe.current!.brandLayout).toBe('splash');

    // splash fade 500ms 后卸载;handoff 尚在 shift 段(t=500 < 950)
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(screen.queryByTestId('splash-panel')).toBeNull();
    expect(probe.current!.phase).toBe('shift');
    expect(probe.current!.brandLayout).toBe('splash');
    expect(screen.getByTestId('login-group').style.opacity).toBe('0');
    expect(screen.getByTestId('login-brand-canvas').style.transition).toBe('');

    // t=950:面板入场(420ms 上滑 20px);Slogan 仍未出现
    await act(async () => {
      vi.advanceTimersByTime(450);
    });
    expect(probe.current!.phase).toBe('panel');
    expect(probe.current!.brandLayout).toBe('login');
    expect(screen.getByTestId('login-brand-canvas').style.transition).toBe(
      `transform ${LOGIN_HANDOFF_TIMINGS.panelMs}ms ${LOGIN_HANDOFF_TIMINGS.panelEasing}`,
    );
    const groupIn = screen.getByTestId('login-group');
    expect(groupIn.style.opacity).toBe('1');
    expect(groupIn.style.transform).toContain('translateY(0px)');
    expect(groupIn.style.transition).toContain('420ms cubic-bezier(.35,.1,.25,1)');
    expect(screen.getByTestId('login-slogan').style.opacity).toBe('0');

    // +100ms Slogan 最后出现(500ms 缓入)
    await act(async () => {
      vi.advanceTimersByTime(100);
    });
    expect(probe.current!.phase).toBe('slogan');
    const slogan = screen.getByTestId('login-slogan');
    expect(slogan.style.opacity).toBe('1');
    expect(slogan.style.transition).toContain('500ms cubic-bezier(.55,.06,.38,.96)');

    // 收尾:done 后品牌固定登录位、面板可点击、全程单面板
    await act(async () => {
      vi.advanceTimersByTime(560);
    });
    expect(probe.current!.phase).toBe('done');
    expect(screen.getByTestId('login-brand-hero').style.left).toBe('443px');
    expect(probe.current!.brandLayout).toBe('login');
    expect(screen.getByTestId('login-brand-canvas').style.transition).toBe('');
    const doneGroup = screen.getByTestId('login-group');
    expect(doneGroup.style.opacity).toBe('1');
    expect(doneGroup.style.pointerEvents).not.toBe('none');
    // 全程单面板:splash 面板已卸载,仅剩 login-panel-identifier 一块
    expect(screen.queryByTestId('splash-panel')).toBeNull();
    expect(
      document.querySelectorAll(
        '[data-testid^="login-panel-"]:not([data-testid="login-panel-stage-root"])',
      ).length,
    ).toBe(1);
    expect(screen.getByTestId('login-panel-identifier')).toBeTruthy();
    fireEvent.click(screen.getByTestId('login-continue-button'));
    expect(screen.getByTestId('login-stage-root').className).toContain('pointer-events-none');
  });

  it('authenticated 冷启动:品牌 Splash 淡出直入主界面,不闪登录面板,overlay 平滑卸载', async () => {
    svc.service.initialize.mockResolvedValue({
      isAuthenticated: true,
      isCanary: false,
      deviceId: 'test-device',
      user: { id: 'u1', name: 'Tester' },
    });
    renderColdStart();
    await flush();

    // 已登录从不挂载 login panel
    expect(screen.queryByTestId('login-panel-stage-root')).toBeNull();
    expect(screen.queryByTestId(/^login-panel-/)).toBeNull();

    loadBrandAssets();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(probe.current!.branch).toBe('authenticated');
    expect(probe.current!.phase).toBe('brand-exit');
    // 淡出中:保持 Splash 品牌布局,只淡出内容层;背景仍不透明,避免透出
    // macOS transparent/vibrancy backing。
    expect(probe.current!.brandLayout).toBe('splash');
    const overlay = screen.getByTestId('login-stage-root');
    expect(overlay.style.opacity).toBe('');
    expect(overlay.style.transition).toBe('');
    const content = screen.getByTestId('login-brand-content');
    expect(content.style.opacity).toBe('0');
    expect(content.style.transition).toContain('--splash-fade-duration');
    const splashPlacement = splashBrandPlacement(window.innerWidth, window.innerHeight);
    expect(screen.getByTestId('login-brand-canvas').style.transform).toBe(
      `translate(-50%, calc(-50% + ${splashPlacement.translateY}px)) scale(${splashPlacement.scale})`,
    );
    expect(screen.getByTestId('login-brand-bg').style.backgroundColor).toContain(
      'var(--login-bg-base)',
    );

    expect(`${LOGIN_HANDOFF_TIMINGS.brandExitMs}ms`).toBe(
      colorRegistry.resolveDefault('splash-fade-duration', 'light'),
    );
    await act(async () => {
      vi.advanceTimersByTime(LOGIN_HANDOFF_TIMINGS.brandExitMs - 1);
    });
    expect(probe.current!.phase).toBe('brand-exit');
    expect(screen.getByTestId('login-brand-bg')).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(probe.current!.phase).toBe('done');
    // overlay 卸载,主界面接管;全程未出现登录面板
    expect(screen.queryByTestId('login-stage-root')).toBeNull();
    expect(screen.queryByTestId('login-panel-stage-root')).toBeNull();
  });

  it('authenticated 冷启动 → 登出回 /login:品牌层重挂为终态(固定登录位/Slogan 直落可见/不重播)——P1 回归', async () => {
    svc.service.initialize.mockResolvedValue({
      isAuthenticated: true,
      isCanary: false,
      deviceId: 'test-device',
      user: { id: 'u1', name: 'Tester' },
    });
    renderColdStart();
    await flush();

    // 走完 authenticated 冷启动:brand-exit 淡出 → done,overlay 卸载
    loadBrandAssets();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(probe.current!.phase).toBe('done');
    expect(screen.queryByTestId('login-stage-root')).toBeNull();

    // 登出:auth:state-change 推送未登录快照 → GuestGate 挂 LoginPage(/login)
    await act(async () => {
      svc.authListener!({
        isAuthenticated: false,
        isCanary: false,
        deviceId: 'test-device',
        user: null,
      });
    });

    // 品牌层重挂(它是背景/立绘/字标/Slogan 唯一渲染者,缺席 = 悬空白面板)
    const overlay = screen.getByTestId('login-stage-root');
    expect(overlay.className).toContain('pointer-events-none');
    // 终态:品牌固定登录位、Slogan 直落可见且无入场过渡(不重播,playedRef 语义)
    const hero = screen.getByTestId('login-brand-hero');
    expect(hero.style.left).toBe('443px');
    expect(hero.style.top).toBe('275px');
    const slogan = screen.getByTestId('login-slogan');
    expect(slogan.style.opacity).toBe('1');
    expect(slogan.style.transition).toBe('');
    // 登录面板同样直落终态可点击,无入场动画重播
    const group = screen.getByTestId('login-group');
    expect(group.style.opacity).toBe('1');
    expect(group.style.transform).toBe('translateY(0px)');
    expect(group.style.transition).toBe('');
    expect(group.style.pointerEvents).not.toBe('none');
    expect(probe.current!.brandLayout).toBe('login');
    // phase 恒 done;跑空全部在途 timer(仅剩 jsdom input focus 的 0ms 内部 timer)
    // 后 phase/视觉零变化 = 不重播(playedRef 语义)
    expect(probe.current!.phase).toBe('done');
    act(() => vi.runAllTimers());
    expect(probe.current!.phase).toBe('done');
    expect(screen.getByTestId('login-slogan').style.opacity).toBe('1');
    expect(screen.getByTestId('login-group').style.opacity).toBe('1');
    expect(screen.getByTestId('login-stage-root')).toBeTruthy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('local cold start uses the entered-app handoff branch', async () => {
    svc.service.initialize.mockResolvedValue({
      isAuthenticated: false,
      mode: 'local',
      dataOwnerId: 'local-v1',
      canEnterApp: true,
      isCanary: false,
      deviceId: 'test-device',
      user: null,
    });
    renderColdStart();
    await flush();

    loadBrandAssets();
    await act(async () => {
      vi.advanceTimersByTime(3_000);
    });
    expect(probe.current!.branch).toBe('authenticated');
    expect(probe.current!.phase).toBe('brand-exit');
  });
});
