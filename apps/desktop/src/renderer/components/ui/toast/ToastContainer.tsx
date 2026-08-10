import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { type ToastItem, getToastSnapshot, subscribeToastStore } from '@/lib/toast';

import { Toast } from './Toast';

// ────────────────────────────────────────────────────────────
// ToastTransitionWrapper — 从右侧滑入 + 淡入，退出滑回右侧 + 淡出
// ---------------------------------------------------------------------------
// 入场：从右侧 16px 外滑入（translate-x-4 → translate-x-0）+ opacity 0→1
// 退场：滑回右侧（translate-x-0 → translate-x-4）+ opacity 1→0
// 过渡时长 300ms，与 lib/toast.ts 的 EXIT_ANIMATION_MS 对齐
// ────────────────────────────────────────────────────────────

function ToastTransitionWrapper({
  item,
  toastId,
  children,
}: {
  item: ToastItem;
  toastId: string;
  children: React.ReactNode;
}) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const isVisible = mounted && !item.exiting;

  return (
    <div data-toast-id={toastId} data-exiting={item.exiting ? 'true' : undefined}>
      <div
        className={cn(
          'transition-[opacity,transform] duration-300 ease-out',
          isVisible ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4',
        )}
      >
        {children}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────
// ToastContainer — 全局容器 + FLIP 位置动画
// ────────────────────────────────────────────────────────────

export function ToastContainer() {
  const { t } = useTranslation();
  const items = useSyncExternalStore(subscribeToastStore, getToastSnapshot, getToastSnapshot);

  const containerRef = useRef<HTMLDivElement>(null);
  const prevRectsRef = useRef<Map<string, number>>(new Map());

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const wrappers = container.querySelectorAll<HTMLElement>('[data-toast-id]');
    const prevTops = prevRectsRef.current;

    // Step 1: 清除所有残留的 FLIP transform，确保测量的是自然布局位置
    wrappers.forEach((el) => {
      el.style.transform = '';
      el.style.transition = 'none';
    });

    // Step 2: 测量每个元素的自然布局位置（无 transform 偏移）
    const naturalTops = new Map<string, number>();
    wrappers.forEach((el) => {
      const id = el.dataset.toastId;
      if (id) naturalTops.set(id, el.getBoundingClientRect().top);
    });

    // Step 3: 对非退场的元素做 FLIP（退场的 toast 原地淡出，不参与位移动画）
    wrappers.forEach((el) => {
      const id = el.dataset.toastId;
      if (!id) return;
      if (el.dataset.exiting === 'true') return; // ← 退场中的 toast 跳过 FLIP

      const prevTop = prevTops.get(id);
      if (prevTop === undefined) return; // 新元素，无旧位置可比

      const newTop = naturalTops.get(id)!;
      const deltaY = prevTop - newTop;
      if (Math.abs(deltaY) < 1) return;

      // Invert: 瞬间跳回旧位置
      el.style.transform = `translateY(${deltaY}px)`;
      // transition 已经在 Step 1 设为 none

      // Play: 下一帧平滑滑到新位置
      requestAnimationFrame(() => {
        el.style.transition = 'transform 300ms ease-out';
        el.style.transform = '';
      });
    });

    // Step 4: 存储自然布局位置（不含 transform），供下次 FLIP 比较
    prevRectsRef.current = naturalTops;
  });

  return (
    <div
      ref={containerRef}
      aria-label={t('commonUi.toastContainer.ariaLabel')}
      // z-[10100]: 高于所有 Radix Dialog (z-[10000]),避免 toast 被打开的对话框遮挡
      className="pointer-events-none fixed right-6 top-6 z-[10100] flex flex-col items-end gap-3"
    >
      {items.map((item) => (
        <ToastTransitionWrapper key={item.id} item={item} toastId={item.id}>
          <Toast item={item} />
        </ToastTransitionWrapper>
      ))}
    </div>
  );
}
