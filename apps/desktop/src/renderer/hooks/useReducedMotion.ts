/**
 * useReducedMotion — 监听系统和宿主外观的"减少动效"偏好
 * ---------------------------------------------------------------------------
 * 包装 `window.matchMedia('(prefers-reduced-motion: reduce)')`。系统设置开启
 * "减少动效" / "Reduce motion" 或宿主 motion=0 时返回 true，调用方应据此把动画时长改成 0 或
 * 直接跳过过渡。
 *
 * SSR-safe: window / matchMedia 不存在时返回 false（Electron renderer 始终有
 * 这两个 API，这里只是养成好习惯，避免后续被 Node 测试环境引用时炸）。
 */

import { useEffect, useState } from 'react';
import { useAppearanceReducedMotion } from '../appearance/AppearanceMotionContext';

const MEDIA_QUERY = '(prefers-reduced-motion: reduce)';

function readInitial(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia(MEDIA_QUERY).matches;
  } catch {
    return false;
  }
}

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(readInitial);
  const appearanceReduced = useAppearanceReducedMotion();

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mql = window.matchMedia(MEDIA_QUERY);
    const handler = (event: MediaQueryListEvent) => setReduced(event.matches);
    // 同步当前值（initial 之后系统偏好可能变化）
    setReduced(mql.matches);
    mql.addEventListener('change', handler);
    return () => {
      mql.removeEventListener('change', handler);
    };
  }, []);

  return reduced || appearanceReduced;
}
