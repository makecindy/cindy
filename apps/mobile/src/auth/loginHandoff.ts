/**
 * loginHandoff —— 移动开机衔接(splash → 登录/首页)状态机与时序契约
 * (PR4b Step 5b WHAT2;纯数据/纯函数,零 react-native,node vitest 直接校验)。
 *
 * readiness 锚(v6.3 冻结):
 *  - 未登录分支推进 = endpoint ∧ OTA ∧ auth-init ∧ assets ∧ login-panel-mounted
 *    (防面板未挂载先播 panel 步);
 *  - 已登录分支不等 panel 信号,品牌屏直入首页不闪登录。
 *
 * 时序参数 = demo docs/cindy-login-hifi.html splashHandoff() 逐值冻结:
 *  spinner/tips 淡出 200ms → +300ms 立绘/字标 650ms cubic-bezier(.33,0,.18,1)
 *  位移到登录位(iPad 横屏 358:833 定稿无位移段,moveMs=0)→ 面板自下而上 20px
 *  渐显 420ms cubic-bezier(.35,.1,.25,1) → +100ms Slogan 500ms
 *  cubic-bezier(.55,.06,.38,.96) 渐显 → +60ms 收束。
 */

import type { LoginSurfaceMode } from './loginSkinLayout';

/** 闸门三态(endpoint 闸;ota/auth-init/assets 只有 pending/ready 两态)。 */
export type HandoffGateStatus = 'pending' | 'error' | 'ready';

/** 衔接阶段:splash 品牌屏 → handoff 播放入场 → done 终态。 */
export type LoginHandoffPhase = 'splash' | 'handoff' | 'done';

export interface LoginHandoffState {
  endpoint: HandoffGateStatus;
  ota: 'pending' | 'ready';
  authInit: 'pending' | 'ready';
  assets: 'pending' | 'ready';
  panelMounted: boolean;
  /** auth-init 完成前 null;完成后 = 是否已登录(决定直入分支) */
  authenticated: boolean | null;
  /** AccessibilityInfo.isReduceMotionEnabled:true 时直落终态不播动画 */
  reducedMotion: boolean;
  phase: LoginHandoffPhase;
}

export type LoginHandoffAction =
  | { type: 'endpoint'; status: HandoffGateStatus }
  | { type: 'ota-ready' }
  | { type: 'auth-init'; authenticated: boolean }
  | { type: 'assets-ready' }
  | { type: 'panel-mounted' }
  | { type: 'reduced-motion'; value: boolean }
  | { type: 'handoff-start' }
  | { type: 'handoff-done' };

export const INITIAL_LOGIN_HANDOFF_STATE: LoginHandoffState = {
  endpoint: 'pending',
  ota: 'pending',
  authInit: 'pending',
  assets: 'pending',
  panelMounted: false,
  authenticated: null,
  reducedMotion: false,
  phase: 'splash',
};

/** readiness 锚(v6.3):未登录含 panel-mounted;已登录不等 panel。 */
export function loginHandoffReadiness(state: LoginHandoffState): boolean {
  const gates =
    state.endpoint === 'ready' &&
    state.ota === 'ready' &&
    state.authInit === 'ready' &&
    state.assets === 'ready';
  if (!gates) return false;
  return state.authenticated === true ? true : state.panelMounted;
}

/**
 * 状态表 reducer(Step 5b「状态表冻结并逐条测试」的确定性核):
 * - endpoint pending→error→retry(pending)→ready 全程可上报;ready 后单向锁定
 *   (闸门 ready 不回退,防晚到事件把 phase 已推进的树打回);
 * - handoff-start 仅从 splash 合法;handoff-done 幂等(reduced-motion/已登录
 *   直入允许 splash→done 直达)。
 */
export function reduceLoginHandoff(
  state: LoginHandoffState,
  action: LoginHandoffAction,
): LoginHandoffState {
  switch (action.type) {
    case 'endpoint': {
      if (state.endpoint === 'ready' && action.status !== 'ready') return state;
      if (state.endpoint === action.status) return state;
      return { ...state, endpoint: action.status };
    }
    case 'ota-ready':
      return state.ota === 'ready' ? state : { ...state, ota: 'ready' };
    case 'auth-init':
      if (state.authInit === 'ready' && state.authenticated === action.authenticated) {
        return state;
      }
      return { ...state, authInit: 'ready', authenticated: action.authenticated };
    case 'assets-ready':
      return state.assets === 'ready' ? state : { ...state, assets: 'ready' };
    case 'panel-mounted':
      return state.panelMounted ? state : { ...state, panelMounted: true };
    case 'reduced-motion':
      return state.reducedMotion === action.value
        ? state
        : { ...state, reducedMotion: action.value };
    case 'handoff-start':
      return state.phase === 'splash' ? { ...state, phase: 'handoff' } : state;
    case 'handoff-done':
      return state.phase === 'done' ? state : { ...state, phase: 'done' };
    default:
      return state;
  }
}

/* ── 时序契约(demo splashHandoff() 逐值冻结) ── */

export const LOGIN_HANDOFF_TIMING = {
  /** spinner/tips 淡出 */
  spinnerFadeMs: 200,
  /** 淡出起步到立绘/字标位移开始的延迟 */
  brandMoveDelayMs: 300,
  /** 立绘/字标位移时长(iPad 横屏无位移变体取 0,见 loginHandoffMoveMs) */
  brandMoveMs: 650,
  /** 面板自下而上渐显时长 */
  panelInMs: 420,
  /** 面板入场起始下移量(设计 px,自下而上 20px) */
  panelInOffsetPx: 20,
  /** 面板起步到 Slogan 起步的间隔 */
  sloganDelayMs: 100,
  /** Slogan 渐显时长 */
  sloganInMs: 500,
  /** Slogan 完成到收束的余量 */
  settleMs: 60,
} as const;

/** cubic-bezier 缓动参数(RN Easing.bezier(...) 消费,与 demo 字面一致)。 */
export const LOGIN_HANDOFF_EASING = {
  brandMove: [0.33, 0, 0.18, 1],
  panelIn: [0.35, 0.1, 0.25, 1],
  sloganIn: [0.55, 0.06, 0.38, 0.96],
} as const;

/** 立绘/字标位移时长:iPad 横屏(358:833 定稿)无位移段 → 0;其余 650ms。 */
export function loginHandoffMoveMs(mode: LoginSurfaceMode): number {
  return (mode === 'pad-landscape' || mode === 'compact-wide') ? 0 : LOGIN_HANDOFF_TIMING.brandMoveMs;
}

/** 面板入场起步时刻(相对 handoff-start;demo 300 + moveMs)。 */
export function loginHandoffPanelDelayMs(mode: LoginSurfaceMode): number {
  return LOGIN_HANDOFF_TIMING.brandMoveDelayMs + loginHandoffMoveMs(mode);
}

/** Slogan 起步时刻(demo 300 + moveMs + 100)。 */
export function loginHandoffSloganDelayMs(mode: LoginSurfaceMode): number {
  return loginHandoffPanelDelayMs(mode) + LOGIN_HANDOFF_TIMING.sloganDelayMs;
}

/** 全程时长(demo 300 + moveMs + 100 + 500 + 60;完成后置 done)。 */
export function loginHandoffTotalMs(mode: LoginSurfaceMode): number {
  return (
    loginHandoffSloganDelayMs(mode) +
    LOGIN_HANDOFF_TIMING.sloganInMs +
    LOGIN_HANDOFF_TIMING.settleMs
  );
}
