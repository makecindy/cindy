/**
 * BannerSlide — 横幅滑入/滑出动画包装器。
 *
 * 入场：从右侧 16px 外滑入（translate-x-4 → translate-x-0）+ opacity 0→1
 * 过渡时长 300ms ease-out，与 ToastTransitionWrapper 对齐。
 */

import { useEffect, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function BannerSlide({ children }: { children: ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  return (
    <div
      className={cn(
        'pointer-events-auto transition-[opacity,transform] duration-300 ease-out',
        mounted ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-4',
      )}
    >
      {children}
    </div>
  );
}