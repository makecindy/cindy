/**
 * SectionCollapse —— 侧栏段落 / 项目树的展开收起高度动画容器。
 * ---------------------------------------------------------------------------
 * 用 CSS grid-template-rows 0fr ↔ 1fr 技巧做高度过渡:无需测量内容高度,
 * 任意动态内容都能平滑收展。收起动画进行中仍挂载 children,播完后卸载,
 * 避免「全部展开再收起」后隐藏子树继续占 React 协调成本。调用方可按业务
 * 需要在收起动画完成后自行复位局部状态;卸载本身也会丢掉内部 state。
 *
 * 同步做透明度渐变(高度收起的同时文字渐隐,对齐 Codex 的收起手感);
 * visibility 参与过渡 —— 收起动画播完后才隐藏(挡键盘焦点/交互),展开瞬间恢复。
 * 时长与曲线走 --motion-base / --motion-ease-move(默认 200ms、cubic-bezier(0.4,0,0.2,1),
 * DESIGN.md §14.4),随「外观 → 动效」倍率缩放;卸载与调用方复位按
 * sectionCollapseDurationMs() 读到的实际时长计时。motion-reduce 下退化为瞬时切换
 * (2026-07 用户定稿的侧栏动效)。
 *
 * 额外 props(如 data-no-drag)透传到外层 grid 容器。
 */

import { useEffect, useState } from 'react';

import { cn } from '@/lib/utils';

/** --motion-base 的默认值;读不到 token 时的回退。 */
export const SECTION_COLLAPSE_DURATION_MS = 200;

/**
 * 收起动画的实际时长(ms):读根元素上的 --motion-base。「外观 → 动效」倍率(0–2)与
 * 减少动态效果都会改写它,写死 200 会在 2 倍时提前卸载、在 0 时多等一拍。
 */
export function sectionCollapseDurationMs(): number {
  if (typeof document === 'undefined') return SECTION_COLLAPSE_DURATION_MS;
  const token = getComputedStyle(document.documentElement).getPropertyValue('--motion-base').trim();
  const value = parseFloat(token);
  if (!Number.isFinite(value) || value < 0) return SECTION_COLLAPSE_DURATION_MS;
  return token.endsWith('ms') || !token.endsWith('s') ? value : value * 1000;
}

interface SectionCollapseProps extends React.HTMLAttributes<HTMLDivElement> {
  collapsed: boolean;
  /** 追加在内层内容容器上的 class(外层 grid 容器用 className)。 */
  innerClassName?: string;
  children: React.ReactNode;
}

export function SectionCollapse({
  collapsed,
  className,
  innerClassName,
  children,
  ...rest
}: SectionCollapseProps) {
  const [keepChildren, setKeepChildren] = useState(!collapsed);

  useEffect(() => {
    if (!collapsed) {
      setKeepChildren(true);
      return undefined;
    }
    const timeoutId = window.setTimeout(() => {
      setKeepChildren(false);
    }, sectionCollapseDurationMs());
    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [collapsed]);

  const mounted = !collapsed || keepChildren;

  return (
    <div
      {...rest}
      className={cn(
        'grid transition-[grid-template-rows] duration-[var(--motion-base,200ms)] ease-[var(--motion-ease-move,cubic-bezier(0.4,0,0.2,1))] motion-reduce:duration-0',
        collapsed ? 'grid-rows-[0fr]' : 'grid-rows-[1fr]',
        className,
      )}
    >
      <div
        aria-hidden={collapsed || undefined}
        data-sidebar-section-collapsed={collapsed ? 'true' : undefined}
        className={cn(
          'min-h-0 overflow-hidden',
          'transition-[opacity,visibility] duration-[var(--motion-base,200ms)] ease-[var(--motion-ease-move,cubic-bezier(0.4,0,0.2,1))] motion-reduce:duration-0',
          collapsed ? 'invisible opacity-0' : 'visible opacity-100',
          innerClassName,
        )}
      >
        {mounted ? children : null}
      </div>
    </div>
  );
}
