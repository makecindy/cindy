import { useCallback, useEffect, useRef } from 'react';

/**
 * 「按下即生效」的兜底:安卓可能在一次按压的中途把这次手势取消掉——第三方输入法
 * 抢走输入焦点时,系统会中断 App 窗口里的这次触摸,`onPress` 于是永远不来,
 * 按钮只闪一下就恢复原样,用户看到的是「点了没反应」(composer 卡片底排整排按钮
 * 都会这样,输入框那行是原生 WebView、不走 RN 响应者系统,反而正常)。
 *
 * 因此给「点一下就做事」的控件加一条兜底:正常松手仍然立即触发(行为不变);
 * 手势被系统取消时,宽限到期后照样触发。手指按下后明显拖动视为放弃这次点击,
 * 不触发——否则划过按钮就会误发。
 */

/** 宽限时长:正常松手远早于它,只有手势被系统取消时才会走到兜底。 */
export const COMPOSER_PRESS_FALLBACK_DELAY_MS = 300;
/** 按下后允许的手指漂移(磅);超出视为放弃这次点击。 */
export const COMPOSER_PRESS_FALLBACK_MAX_DRIFT_PT = 12;

export interface ComposerPressFallback {
  /** 按下:记录起点并排宽限定时器。 */
  beginPress(x: number, y: number): void;
  /** 手指移动:偏移超过容差视为放弃,取消兜底。 */
  movePress(x: number, y: number): void;
  /**
   * 正常松手:取消兜底。返回 true 表示兜底已经先执行过动作,调用方不要再执行一次。
   */
  finishPress(): boolean;
}

export interface ComposerPressFallbackOptions {
  /** 关掉时完全不排定时器(给有自己按压语义的控件用)。 */
  enabled: boolean;
  delayMs?: number;
  maxDriftPt?: number;
  /** 兜底触发时执行的动作。 */
  onPress: () => void;
}

export function useComposerPressFallback(options: ComposerPressFallbackOptions): ComposerPressFallback {
  const {
    enabled,
    delayMs = COMPOSER_PRESS_FALLBACK_DELAY_MS,
    maxDriftPt = COMPOSER_PRESS_FALLBACK_MAX_DRIFT_PT,
    onPress,
  } = options;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);
  const originRef = useRef<{ x: number; y: number } | null>(null);
  const onPressRef = useRef(onPress);
  onPressRef.current = onPress;

  const cancel = useCallback(() => {
    if (timerRef.current === null) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);

  // 按下后控件变为禁用(如断线/忙碌翻转)时,撤销待执行的兑底动作:禁用态下不应再
  // 打开面板或发送,松手路径的 onPress 本就已被 Pressable 的 disabled 拦住。
  useEffect(() => {
    if (!enabled) cancel();
  }, [cancel, enabled]);

  const beginPress = useCallback((x: number, y: number) => {
    firedRef.current = false;
    originRef.current = { x, y };
    cancel();
    if (!enabled) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      if (firedRef.current) return;
      firedRef.current = true;
      onPressRef.current();
    }, delayMs);
  }, [cancel, delayMs, enabled]);

  const movePress = useCallback((x: number, y: number) => {
    if (timerRef.current === null) return;
    const origin = originRef.current;
    if (!origin) return;
    if (Math.hypot(x - origin.x, y - origin.y) > maxDriftPt) cancel();
  }, [cancel, maxDriftPt]);

  const finishPress = useCallback(() => {
    cancel();
    const fired = firedRef.current;
    firedRef.current = false;
    return fired;
  }, [cancel]);

  return { beginPress, movePress, finishPress };
}
