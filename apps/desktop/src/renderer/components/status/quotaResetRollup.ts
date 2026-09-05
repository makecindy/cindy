/**
 * quotaResetRollup — TodaySpendChip 限额窗口的「重置滚动」动画与倒计时节奏。
 *
 * 两个职责(都只服务 chip 上的剩余百分比段):
 *   1. 窗口重置检测 + 数字滚动:同一窗口到期后,新周期快照确认剩余百分比回升
 *      (典型:5h 窗口到点重置, 剩余 0% → 100%)时, 让显示值从 0% 快速滚动到
 *      新值, 给用户一个「额度回来了」的可感知反馈。一次性 JS 文本更新动画,
 *      非常驻(engineering-conventions §7), 且尊重 prefers-reduced-motion
 *      (降级为直接跳到终值, DESIGN §14.4)。
 *   2. 倒计时 tick 节奏:chip 的窗口 label 是距 reset 的剩余时长, 常态 60s
 *      刷一次足够;进入最后一分钟后切到每秒 tick, 让「59秒 → 1秒」逐秒走动。
 *
 * 纯函数(shouldCelebrateQuotaReset / rollupDisplayPercent /
 * computeCountdownTickDelayMs)拆出来供单测;hook 只做 React 接线。
 */

import * as React from 'react';

/** chip 上一个限额窗口段的动画素材(由 TodaySpendChip 的窗口派生函数产出)。 */
export interface ChipWindowSlot {
  /**
   * 窗口身份 key(如 'claude-5h' / 'codex-primary:300')。身份变化 = 换了
   * 一个窗口(如周限从总周限切到 scoped), 此时只重置基线, 绝不触发动画。
   */
  key: string;
  /** 剩余百分比(0-100, 已 clamp)。 */
  remainingPercent: number;
  /** reset 时间点(ms epoch);上游没给时 null。 */
  resetsAtMs: number | null;
}

/** 滚动动画时长:短到不烦人, 长到数字「跳动」可感知。 */
export const ROLLUP_DURATION_MS = 1200;
/** 滚到终值后庆祝色(done 绿)的停留时长, 之后淡回常规色 —— 揭晓的「余韵」。 */
export const ROLLUP_SETTLE_MS = 700;

/** 常态 tick(分钟级倒计时够用)。 */
export const COUNTDOWN_TICK_SLOW_MS = 60_000;
/** 最后一分钟的秒级 tick。 */
export const COUNTDOWN_TICK_FAST_MS = 1_000;
/** 距 reset 只剩这么多毫秒内(含刚过点的一小段)切秒级 tick。 */
const FAST_TICK_WINDOW_MS = 61_000;
/** reset 过点后继续秒级 tick 的宽限(等 label 落回窗口名 / 快照刷新)。 */
const FAST_TICK_GRACE_MS = 5_000;
/**
 * 悬念期上限: 过点这么久后还没等到新快照就放弃悬念(「重置中…」→ 回落旧值 +
 * 窗口名)。催刷是 best-effort —— 离线、登出、端点故障或退避期间可能一直拿不到
 * 新快照, 无上限的悬念会永远挂着。定义放本模块: tick 节奏(下方)必须踩着这个
 * 边界调度, 悬念判定(TodaySpendChip.isResetPending)与调度共用同一常量。
 */
export const RESET_PENDING_MAX_MS = 10 * 60_000;

/**
 * 只有同一额度窗口已经到期、新快照进入未来周期且余量回升才庆祝。
 * 缺少周期信息、同周期修正或未来截止时间微调都不能证明发生了重置。
 * 不猜测服务端时钟偏差;本机尚未到期时直接显示新余量,不补播庆祝。
 */
export function shouldCelebrateQuotaReset(
  prev: ChipWindowSlot | null,
  next: ChipWindowSlot | null,
  nowMs: number = Date.now(),
): boolean {
  if (!prev || !next || prev.key !== next.key) return false;
  return Number.isFinite(prev.remainingPercent)
    && Number.isFinite(next.remainingPercent)
    && next.remainingPercent - prev.remainingPercent >= 1
    && typeof prev.resetsAtMs === 'number'
    && typeof next.resetsAtMs === 'number'
    && Number.isFinite(prev.resetsAtMs)
    && Number.isFinite(next.resetsAtMs)
    && prev.resetsAtMs > 0
    && prev.resetsAtMs <= nowMs
    && next.resetsAtMs > nowMs;
}

/**
 * 滚动动画某一时刻的显示值:0 → target, ease-out cubic(前段跳得快、
 * 尾段收住), 完成后恒等于 target。
 */
export function rollupDisplayPercent(
  targetPercent: number,
  elapsedMs: number,
  durationMs: number = ROLLUP_DURATION_MS,
): number {
  if (elapsedMs >= durationMs || durationMs <= 0) return targetPercent;
  if (elapsedMs <= 0) return 0;
  const progress = elapsedMs / durationMs;
  const eased = 1 - Math.pow(1 - progress, 3);
  return targetPercent * eased;
}

/**
 * 下一次倒计时 tick 的延迟:任一窗口距 reset 在最后一分钟内(或刚过点的
 * 宽限里)→ 秒级;否则分钟级, 但不能越过两类边界:
 *   - 「进入最后一分钟」边界 —— 否则剩 75 秒时下一跳排在 60 秒后, label 会
 *     僵住整整一分钟、错过秒级切换(下一跳精确落在 remain=61s 边界上,
 *     秒跳从 59 秒完整开始);
 *   - 「悬念期超时」边界(resetsAt + RESET_PENDING_MAX_MS)—— 悬念判定只在
 *     tick 时重算, 60s 慢 tick 越过超时点会让「重置中…」多挂最长一分钟。
 * 传入的是 chip 当前实际展示的窗口 resetsAt 列表。
 */
export function computeCountdownTickDelayMs(
  resetsAtMsList: ReadonlyArray<number | null>,
  nowMs: number,
): number {
  let delay = COUNTDOWN_TICK_SLOW_MS;
  for (const resetsAtMs of resetsAtMsList) {
    if (typeof resetsAtMs !== 'number' || !Number.isFinite(resetsAtMs)) continue;
    const remainMs = resetsAtMs - nowMs;
    if (remainMs <= FAST_TICK_WINDOW_MS && remainMs > -FAST_TICK_GRACE_MS) {
      return COUNTDOWN_TICK_FAST_MS;
    }
    if (remainMs > FAST_TICK_WINDOW_MS) {
      delay = Math.min(delay, remainMs - FAST_TICK_WINDOW_MS);
    } else {
      // 已过点(宽限外), 悬念期挂着: 下一跳不越过超时边界, 到点立刻退出悬念。
      const untilPendingExpiryMs = resetsAtMs + RESET_PENDING_MAX_MS - nowMs;
      if (untilPendingExpiryMs > 0) {
        delay = Math.min(delay, untilPendingExpiryMs);
      }
    }
  }
  return Math.max(COUNTDOWN_TICK_FAST_MS, delay);
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 进行中的滚动动画描述符;对象身份在整个动画期间稳定(effect 只启动一次)。 */
interface RollupAnimation {
  key: string;
  resetsAtMs: number | null;
  targetPercent: number;
  startedAtMs: number;
}

/** useQuotaResetRollup 的输出:显示值 + 是否处于庆祝态(滚动中或绿色余韵)。 */
export interface QuotaResetRollupState {
  percent: number;
  /** true = 滚动进行中或已到终值的余韵期 —— 调用方据此给段落上庆祝色。 */
  celebrating: boolean;
}

/**
 * 一个 chip 窗口段的显示状态:常态透传 remainingPercent;检测到重置时
 * 返回 0 → 新值的滚动值(rAF 驱动, 一次性), 滚到终值后再保持 celebrating
 * ROLLUP_SETTLE_MS(庆祝色余韵), 之后回到常态透传。
 * slot 为 null(该段无数据)时返回 null。
 *
 * 重置检测放在 render 阶段(对比上一次渲染的 slot 值), 命中时用 render-phase
 * setState 落一个身份稳定的动画描述符 —— 不能用「本轮 celebrate 布尔」当 effect
 * 依赖:动画帧重渲染会让它翻回 false, cleanup 会当场取消刚起步的动画。
 */
export function useQuotaResetRollup(slot: ChipWindowSlot | null): QuotaResetRollupState | null {
  const [prev, setPrev] = React.useState<ChipWindowSlot | null>(slot);
  const [anim, setAnim] = React.useState<RollupAnimation | null>(null);
  // 动画当前帧时间戳;anim 存续期间由 rAF 循环驱动重渲染。
  const [frameNowMs, setFrameNowMs] = React.useState(0);

  // 基线随 React render 一起提交/回滚,不能在未提交的 render 中写 ref。
  // 同一身份不退回已观察过的旧周期,避免迟到旧快照 → 当前快照重复揭晓。
  const staleCycle = prev && slot && prev.key === slot.key
    && typeof prev.resetsAtMs === 'number'
    && (slot.resetsAtMs === null || slot.resetsAtMs < prev.resetsAtMs);
  // 周期只前进,但百分比必须跟随已经展示的值。稀疏快照先显示98%后补齐截止
  // 时间时,应比较98%→98%,不能继续拿更早的60%当基线。
  const nextBaseline = staleCycle ? { ...slot, resetsAtMs: prev.resetsAtMs } : slot;
  const slotChanged = prev?.key !== nextBaseline?.key
    || !Object.is(prev?.remainingPercent, nextBaseline?.remainingPercent)
    || !Object.is(prev?.resetsAtMs, nextBaseline?.resetsAtMs);
  // 切走/缺失/周期失配必须清掉描述符和计时器,不能仅隐藏输出后再复活旧动画。
  if (anim && (!slot || anim.key !== slot.key || anim.resetsAtMs !== slot.resetsAtMs)) {
    setAnim(null);
  }
  if (slotChanged) {
    setPrev(nextBaseline);
    if (slot && shouldCelebrateQuotaReset(prev, slot) && !prefersReducedMotion()) {
      setAnim({
        key: slot.key,
        resetsAtMs: slot.resetsAtMs,
        targetPercent: slot.remainingPercent,
        startedAtMs: performance.now(),
      });
      setFrameNowMs(0);
    }
  }

  React.useEffect(() => {
    if (!anim) return undefined;
    let settleTimer: number | null = null;
    let rafId = requestAnimationFrame(function step(frameNow: number) {
      if (frameNow - anim.startedAtMs >= ROLLUP_DURATION_MS) {
        // 滚动到底: 停 rAF, 余韵期结束后再摘掉庆祝态。
        setFrameNowMs(frameNow);
        settleTimer = window.setTimeout(() => setAnim(null), ROLLUP_SETTLE_MS);
        return;
      }
      setFrameNowMs(frameNow);
      rafId = requestAnimationFrame(step);
    });
    return () => {
      cancelAnimationFrame(rafId);
      if (settleTimer !== null) window.clearTimeout(settleTimer);
    };
  }, [anim]);

  if (!slot) return null;
  // 动画值只对同一窗口生效;窗口身份切换时立即回到真实值。数字取整, 滚动期间
  // 不显示小数抖动;余韵期显示真实终值(仅颜色仍是庆祝色)。
  if (anim && anim.key === slot.key) {
    const elapsed = Math.max(0, frameNowMs - anim.startedAtMs);
    return {
      percent: elapsed >= ROLLUP_DURATION_MS
        ? slot.remainingPercent
        : Math.round(rollupDisplayPercent(anim.targetPercent, elapsed)),
      celebrating: true,
    };
  }
  return { percent: slot.remainingPercent, celebrating: false };
}
