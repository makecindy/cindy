/**
 * FadeSwitcher
 * ---------------------------------------------------------------------------
 * F4 主区域切换动画容器。
 *
 * 实现要点：
 * - 父组件（MainLayout）通过 <FadeSwitcher key={location.pathname}> 控制实例身份。
 *   key 变化 → React 在父组件 commit 时销毁旧实例 + 挂载新实例 → 本组件 mount effect
 *   从 opacity 0 → 1 触发 220ms transition。
 *   key 必须挂在父组件渲染处，挂在自身根 div 不会触发实例销毁重挂（React 仍视为同一实例）。
 * - 动画进行中再次切路由 → React 直接卸载未完成的子树（不会"等动画结束"），
 *   实现"立即打断 = 重挂"语义，无需手动状态机。
 * - prefers-reduced-motion: reduce → 关闭 transition，瞬间替换。
 * - 动画结束 transitionend 事件清除 will-change，避免合成层堆积。
 *
 * 性能边界（F4）：仅 opacity 变化，禁止 width/height/top/left/margin/padding 动画。
 *
 * 动画时序与性能边界以本组件注释和 docs/design-rules/cindy-design-system.md 为准。
 */

import { useEffect, useMemo, useState, type ReactNode, type TransitionEvent } from 'react';

interface FadeSwitcherProps {
  children: ReactNode;
}

// requestAnimationFrame can be indefinitely throttled for an Electron window
// that has not painted yet. Never leave an already-mounted route invisible.
const REVEAL_FALLBACK_MS = 500;

export function FadeSwitcher({ children }: FadeSwitcherProps) {
  const [opacity, setOpacity] = useState(0);
  const [willChange, setWillChange] = useState<'opacity' | 'auto'>('opacity');

  // 检测 reduce-motion 偏好（一次性，不订阅运行时变更——边缘场景）
  // useMemo 缓存避免渲染体内每次同步读 matchMedia。
  const reduceMotion = useMemo(
    () =>
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    [],
  );

  // mount 时跑一次：从 opacity 0 过渡到 1。
  // 路由变化由父组件传入的 key 触发本组件实例销毁+重挂 → 此 effect 重跑。
  useEffect(() => {
    if (reduceMotion) {
      setOpacity(1);
      setWillChange('auto');
      return;
    }
    setOpacity(0);
    setWillChange('opacity');
    // 必须等下一帧再切 1，否则 React 会把两次 setState 批处理为一次 commit，
    // 浏览器看不到 0→1 的变化，transition 不触发。
    let frameId: number | null = null;
    const reveal = () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      clearTimeout(fallbackId);
      setOpacity(1);
    };
    const fallbackId = window.setTimeout(reveal, REVEAL_FALLBACK_MS);
    frameId = requestAnimationFrame(reveal);
    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId);
      clearTimeout(fallbackId);
    };
  }, [reduceMotion]);

  const handleTransitionEnd = (e: TransitionEvent<HTMLDivElement>) => {
    if (e.propertyName === 'opacity') {
      setWillChange('auto'); // 动画结束清除 will-change
    }
  };

  return (
    <div
      onTransitionEnd={handleTransitionEnd}
      className="flex flex-1 flex-col overflow-hidden"
      style={{
        opacity,
        willChange,
        transition: reduceMotion
          ? 'none'
          : 'opacity 220ms cubic-bezier(0.16, 1, 0.3, 1)',
      }}
    >
      {children}
    </div>
  );
}
