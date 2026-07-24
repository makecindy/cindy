import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

/**
 * LoginHandoffContext — 开机 Splash → 登录/主界面 衔接动画的状态机宿主
 * (implementation-plan Step 3b WHAT2,时序权威 = design.md §3.1 / demo splashHandoff())。
 *
 * 所有权契约(v4/v6.12 冻结):
 * - `LoginBrandStage` = 品牌视觉层(白底体系背景渐变/立绘/字标/Slogan)唯一渲染者,
 *   overlay pointer-events:none,仅主窗挂载;
 * - 白色输入面板与第三方圆钮行归 LoginPage 唯一拥有,本 context 只协调面板层的
 *   opacity/transform 入场,不重复渲染;
 * - SplashScreen 退化为 loading/tips/进度层(统一白面板),经 reportSplashExited
 *   通知本机退场时刻。
 *
 * 两分支(无 auth-init-failed 虚构分支,初始化异常已在 AuthContext 归一未登录):
 * - unauthenticated 冷启动:settle(300ms)→shift(650ms cubic-bezier(.33,0,.18,1))
 *   →panel(420ms 上滑 20px cubic-bezier(.35,.1,.25,1))→slogan(+100ms,500ms
 *   cubic-bezier(.55,.06,.38,.96),Slogan 最后出现)。
 *   注:wave4 Splash 五帧(379:581 等)实测品牌五要素坐标与登录帧 368:1375 完全一致
 *   (立绘 443,275/字标容器 570,1029/SLOGAN 1191,863)——Splash 位 = 登录位,shift 段
 *   位移量为 0,但相位与时长照 demo 时间轴保留(面板入场锚定在 t=950ms)。
 *   demo 的 227px 位移属旧 wave3 帧(366:845)静态呈现,已被 wave4 帧行取代
 *   (附录 B 分层基准:Splash 静态布局=wave4,demo 只验阶段-文案-时序)。
 * - authenticated 冷启动:品牌 Splash 淡出直入主界面,不闪登录面板,overlay 平滑卸载。
 *
 * 推进锚 = 品牌资产 onload ∧ auth 初始化完成 ∧ Splash 已退场;未登录分支另需
 * 「面板已挂载」信号后才进 panel 步。冷启动每次播放(仅未登录分支);尺寸切换/reset
 * 不重播(playedRef 进程级一次);prefers-reduced-motion 直落终态。
 */

/* ── 时序常量(demo splashHandoff() 逐字对照,单测锚点) ── */
export const LOGIN_HANDOFF_TIMINGS = Object.freeze({
  /** 步骤 2 缓冲:立绘+字标停留 0.3s(demo setTimeout 300)。 */
  settleMs: 300,
  /** 步骤 3 位移段时长(wave4 下位移量为 0,相位保留)。 */
  shiftMs: 650,
  shiftEasing: 'cubic-bezier(.33,0,.18,1)',
  /** 步骤 4 面板入场:opacity 0→1 + 自下而上 20px。 */
  panelMs: 420,
  panelEasing: 'cubic-bezier(.35,.1,.25,1)',
  panelRisePx: 20,
  /** 步骤 5 Slogan:面板开始后 +100ms,500ms;必须最后出现。 */
  sloganDelayMs: 100,
  sloganMs: 500,
  sloganEasing: 'cubic-bezier(.55,.06,.38,.96)',
  /** demo 收尾 buffer(300+moveMs+100+500+60 后 commit)。 */
  doneBufferMs: 60,
  /** authenticated 分支品牌淡出时长(与 splash fade 同步,--splash-fade-duration)。 */
  brandExitMs: 500,
} as const);

export type LoginHandoffPhase =
  | 'boot' // 等推进锚(品牌资产 ∧ auth init ∧ splash 退场)
  | 'settle' // t=0~300ms
  | 'shift' // t=300~950ms
  | 'awaiting-panel' // shift 结束但「面板已挂载」信号未到(仅未登录)
  | 'panel' // 面板入场中
  | 'slogan' // Slogan 入场中(面板开始 +100ms)
  | 'brand-exit' // authenticated:品牌 overlay 淡出中
  | 'done';

export type LoginHandoffBranch = 'unauthenticated' | 'authenticated' | null;

export interface LoginHandoffContextValue {
  phase: LoginHandoffPhase;
  branch: LoginHandoffBranch;
  /**
   * 登录面板下方内容需要预留的高度；null 表示 LoginPage 尚未上报，
   * 品牌层应使用常态本地模式 footer 的预留值。
   */
  panelBottomReserve: number | null;
  /** 播放中(boot 之后、done 之前)——面板/Slogan 的入场 transition 只在此期挂。 */
  isPlaying: boolean;
  /** 品牌 overlay 是否应挂载(startup 期恒挂;done 后跟随 login 面板存在;authenticated 淡出后卸载)。 */
  brandStageMounted: boolean;
  /** authenticated 分支淡出中(LoginBrandStage 消费为 opacity 过渡)。 */
  brandExiting: boolean;
  /** 面板已进入可见段(panel/slogan/done)。 */
  panelRevealed: boolean;
  /** Slogan 已进入可见段(slogan/done)——必须最后出现。 */
  sloganRevealed: boolean;
  reportBrandAssetsReady: () => void;
  reportSplashExited: () => void;
  reportLoginPanelMounted: () => void;
  reportLoginPanelUnmounted: () => void;
  reportPanelBottomReserve: (reserve: number | null) => void;
}

const LoginHandoffContext = createContext<LoginHandoffContextValue | null>(null);

/**
 * Provider 缺失时的静态兜底(单测直接 render LoginPage/LoginBrandStage 等场景):
 * 视为已播完——面板/Slogan 直落终态、品牌 overlay 常挂、reporter 全 no-op。
 */
const FALLBACK_VALUE: LoginHandoffContextValue = Object.freeze({
  phase: 'done',
  branch: null,
  panelBottomReserve: null,
  isPlaying: false,
  brandStageMounted: true,
  brandExiting: false,
  panelRevealed: true,
  sloganRevealed: true,
  reportBrandAssetsReady: () => {},
  reportSplashExited: () => {},
  reportLoginPanelMounted: () => {},
  reportLoginPanelUnmounted: () => {},
  reportPanelBottomReserve: () => {},
});

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function LoginHandoffProvider({
  children,
  authResolved,
  authenticated,
}: {
  children: ReactNode;
  /** auth 初始化完成(= !isInitializing;App.tsx 内层 host 从 useAuth 取,避免本模块传递性引入 AuthContext 重依赖)。 */
  authResolved: boolean;
  /** auth 初始化结果分支(仅在 authResolved 后读)。 */
  authenticated: boolean;
}) {
  const [phase, setPhase] = useState<LoginHandoffPhase>('boot');
  const [branch, setBranch] = useState<LoginHandoffBranch>(null);
  const [brandReady, setBrandReady] = useState(false);
  const [splashExited, setSplashExited] = useState(false);
  const [panelMounted, setPanelMounted] = useState(false);
  const [panelBottomReserve, setPanelBottomReserve] = useState<number | null>(null);

  // 冷启动只播一次:进程生命周期内 resize/reset/登出重回 /login 均不重播。
  const playedRef = useRef(false);
  const panelMountedRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const schedule = useCallback((fn: () => void, ms: number) => {
    const timer = setTimeout(fn, ms);
    timersRef.current.push(timer);
    return timer;
  }, []);

  // 卸载时清全部在途 timer(handoff fake-timer 用例断言清理)。
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current = [];
    };
  }, []);

  const reportBrandAssetsReady = useCallback(() => setBrandReady(true), []);
  const reportSplashExited = useCallback(() => setSplashExited(true), []);
  const reportLoginPanelMounted = useCallback(() => {
    panelMountedRef.current = true;
    setPanelMounted(true);
  }, []);
  const reportLoginPanelUnmounted = useCallback(() => {
    panelMountedRef.current = false;
    setPanelMounted(false);
  }, []);
  const reportPanelBottomReserve = useCallback(
    (reserve: number | null) => setPanelBottomReserve(reserve),
    [],
  );

  // ── 推进锚:品牌资产 onload ∧ auth 初始化完成 ∧ Splash 退场 → 起播(一次) ──
  useEffect(() => {
    if (playedRef.current) return;
    if (!brandReady || !splashExited || !authResolved) return;
    playedRef.current = true;

    const nextBranch: LoginHandoffBranch = authenticated ? 'authenticated' : 'unauthenticated';
    setBranch(nextBranch);

    // reduced-motion 直落终态:无位移/无渐入过程。
    if (prefersReducedMotion()) {
      setPhase('done');
      return;
    }

    if (nextBranch === 'authenticated') {
      // 品牌 Splash 淡出直入主界面,不闪登录面板。
      setPhase('brand-exit');
      schedule(() => setPhase('done'), LOGIN_HANDOFF_TIMINGS.brandExitMs);
      return;
    }

    setPhase('settle');
    schedule(() => setPhase('shift'), LOGIN_HANDOFF_TIMINGS.settleMs);
    schedule(
      // 未登录分支另需「面板已挂载」信号后才进 panel 步。
      () => setPhase(panelMountedRef.current ? 'panel' : 'awaiting-panel'),
      LOGIN_HANDOFF_TIMINGS.settleMs + LOGIN_HANDOFF_TIMINGS.shiftMs,
    );
  }, [brandReady, splashExited, authResolved, authenticated, schedule]);

  // awaiting-panel → panel:面板挂载信号到达即刻放行。
  useEffect(() => {
    if (phase === 'awaiting-panel' && panelMounted) setPhase('panel');
  }, [phase, panelMounted]);

  // panel → slogan(+100ms) → done(slogan 起步 +500ms 动画 +60ms demo buffer)。
  useEffect(() => {
    if (phase === 'panel') {
      schedule(() => setPhase('slogan'), LOGIN_HANDOFF_TIMINGS.sloganDelayMs);
      return;
    }
    if (phase === 'slogan') {
      schedule(
        () => setPhase('done'),
        LOGIN_HANDOFF_TIMINGS.sloganMs + LOGIN_HANDOFF_TIMINGS.doneBufferMs,
      );
    }
  }, [phase, schedule]);

  const value = useMemo<LoginHandoffContextValue>(() => {
    const isPlaying = phase !== 'boot' && phase !== 'done';
    return {
      phase,
      branch,
      panelBottomReserve,
      isPlaying,
      // startup 期(含 boot/播放中/brand-exit)恒挂以维持不透明白底全盖;done 后
      // 一律跟随登录面板存在:authenticated 淡出完成且无面板 → 卸载;之后登出
      // 回 /login,LoginPage 上报面板挂载 → 品牌层重挂(phase 恒 done = 终态:
      // 品牌固定登录位、Slogan 直落可见、无过渡不重播——playedRef 语义不变)。
      // 判定刻意不绑 branch:绑死会让 authenticated 冷启动后登出的 /login 永久
      // 丢失品牌层(登录页只剩悬空白面板,2026-07-20 对抗 review P1)。
      brandStageMounted: phase !== 'done' ? true : panelMounted,
      brandExiting: phase === 'brand-exit',
      panelRevealed: phase === 'panel' || phase === 'slogan' || phase === 'done',
      sloganRevealed: phase === 'slogan' || phase === 'done',
      reportBrandAssetsReady,
      reportSplashExited,
      reportLoginPanelMounted,
      reportLoginPanelUnmounted,
      reportPanelBottomReserve,
    };
  }, [
    phase,
    branch,
    panelMounted,
    panelBottomReserve,
    reportBrandAssetsReady,
    reportSplashExited,
    reportLoginPanelMounted,
    reportLoginPanelUnmounted,
    reportPanelBottomReserve,
  ]);

  return <LoginHandoffContext.Provider value={value}>{children}</LoginHandoffContext.Provider>;
}

export function useLoginHandoff(): LoginHandoffContextValue {
  return useContext(LoginHandoffContext) ?? FALLBACK_VALUE;
}
