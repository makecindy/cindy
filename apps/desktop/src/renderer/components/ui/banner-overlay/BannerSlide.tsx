/**
 * BannerSlide — 横幅缩放淡入动画包装器。
 *
 * 入场：从 95% 缩放 + 透明 → 100% 缩放 + 不透明（scale-95→scale-100 + opacity 0→1）
 * 过渡时长 300ms ease-out，居中弹窗的标准入场动画。
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
        mounted ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
      )}
    >
      {children}
    </div>
  );
}