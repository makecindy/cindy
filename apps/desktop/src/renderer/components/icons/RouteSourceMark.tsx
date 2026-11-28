import type { ReactNode } from 'react';
import { Sparkle } from 'lucide-react';

/**
 * 「这一格是合并了几个供应商的路由」的标识：品牌图形右上角外侧叠一颗简洁的单星。
 * 与 RemoteSourceMark(右上角的信号波纹 = 在另一台电脑上)同一个位置、同一种读法，两者不同时出现：
 * 合并后的条目列在任务所在电脑的目录里，它的成员在哪里由路由决定。
 * 父级不能裁剪溢出；颜色跟随 currentColor。
 */
export function RouteSourceMark({ markSize = 16, children }: {
  /** children 的原生边长，px；决定角标大小。 */
  markSize?: number;
  /** 品牌图形(ProviderMark 等，不要带外边距)。 */
  children: ReactNode;
}) {
  const size = Math.max(8, Math.round(markSize * 0.56));
  return (
    <span aria-hidden data-route-source-mark className="relative inline-flex shrink-0">
      {children}
      <Sparkle
        size={size}
        fill="currentColor"
        stroke="currentColor"
        strokeWidth={0.6}
        className="pointer-events-none absolute"
        style={{ right: -Math.round(size * 0.65), top: -Math.round(size * 0.45) }}
      />
    </span>
  );
}
