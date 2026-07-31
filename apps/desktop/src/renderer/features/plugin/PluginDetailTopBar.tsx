/**
 * Shared sticky top bar for both Plugin detail surfaces (installed + market).
 *
 * Inputs: the back affordance's label and handler, plus the owning scroll frame's scrolled flag.
 * Outputs: the back button and, on macOS, the page's own window-drag region.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { useCallback, useState, type UIEvent } from 'react';
import { ArrowLeft } from 'lucide-react';

import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import { cn } from '@/lib/utils';

interface PluginDetailTopBarProps {
  label: string;
  onBack: () => void;
  /** 滚动帧是否已离开顶部；顶栏据此从透明切到实底 + hairline。 */
  scrolled: boolean;
}

/**
 * 详情页滚动帧的「已离开顶部」判定。返回的 onScroll 直接挂在滚动容器上;
 * scrollTop > 0 是布尔量,同值 setState 由 React bail out,重渲染只发生在
 * 跨越顶部的那一次。
 */
export function usePluginDetailScrolled(): {
  scrolled: boolean;
  onScroll: (event: UIEvent<HTMLElement>) => void;
} {
  const [scrolled, setScrolled] = useState(false);
  const onScroll = useCallback((event: UIEvent<HTMLElement>) => {
    setScrolled(event.currentTarget.scrollTop > 0);
  }, []);
  return { scrolled, onScroll };
}

/**
 * 详情页顶行:返回入口 + mac 侧的窗口拖拽区。
 *
 * mac 上通用 ContentHeader 在「侧栏展开 + 无注入内容 + 无右栏」时整条隐藏
 * (ContentHeader.tsx 的 useContentHeaderHidden),自带顶部内容的页面自行承担
 * 窗口拖动(windowDrag.tsx 的约定),本行是插件详情页的那一份。Windows /
 * Linux 的通用 header 常驻,那 46px 即窗口抓手,本行在这两端纯作视觉顶栏。
 * 行内交互元素标 no-drag 挖洞,且必须是本行的后代 —— Electron 的挖洞只在
 * drag 元素自身后代上生效。
 *
 * sticky 让拖拽区在任意滚动位置都在场。滚动态为实底:正文滚到本行下方会落进
 * Electron 的 drag 矩形,实底背景同时把这些元素遮住,视觉与命中区一致。
 *
 * 高度 h-16 + 内容垂直居中,与列表页 PluginManagementHeader 同规格
 * (PluginManagementLayout.tsx:212),列表与详情间切换时顶栏高度恒定。窄宽度
 * 下列表页顶栏撑到 7rem 排两行(plugin-motion.css 的 container query),本行
 * 恒为 h-16。
 *
 * hairline 走 after 伪元素,脱离布局流,透明态与实底态之间高度恒定;article 的
 * pt-5 之下,hero 起点为 64 + 20 = 84px。
 */
export function PluginDetailTopBar({ label, onBack, scrolled }: PluginDetailTopBarProps) {
  const { isMac } = useMacFullscreen();

  return (
    <div
      data-testid="plugin-detail-top-bar"
      className={cn(
        'sticky top-0 z-20 w-full',
        'after:pointer-events-none after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[var(--border-default)]',
        'transition-[background-color] duration-150 after:transition-opacity after:duration-150',
        'motion-reduce:transition-none motion-reduce:after:transition-none',
        scrolled ? 'bg-[var(--surface)] after:opacity-100' : 'bg-transparent after:opacity-0',
      )}
      style={isMac ? WINDOW_DRAG_STYLE : undefined}
    >
      <div className="mx-auto flex h-16 w-full max-w-[824px] items-center px-8 max-[760px]:px-6">
        <button
          type="button"
          onClick={onBack}
          className="-ml-3 inline-flex h-9 w-fit select-none items-center gap-2 rounded-full px-3 text-13 text-[var(--text-secondary)] transition-colors duration-150 hover:bg-[var(--surface-hover-soft)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          style={WINDOW_NO_DRAG_STYLE}
        >
          <ArrowLeft size={16} aria-hidden="true" />
          {label}
        </button>
      </div>
    </div>
  );
}
