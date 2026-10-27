/**
 * Collapse —— 聊天流卡片通用的展开 / 收起高度动画容器。
 * ---------------------------------------------------------------------------
 * DESIGN.md §14.4「展开/折叠」原型的挂载编排版:与侧栏 `SectionCollapse` 同一
 * 套 grid-template-rows 0fr ↔ 1fr 技巧(无需测量内容高度)、同 200ms /
 * ease-move 参数,差异在于**内容收起后卸载**——聊天流的展开体(工具输出 /
 * thinking 正文等)可能很重,长会话里不允许常驻 DOM,这也是不能直接复用
 * 常挂载型 SectionCollapse 的原因。
 *
 * 编排规则:
 * - 首次挂载**不播动画**(初始即终态):虚拟滚动 / 切会话时历史卡片以当前
 *   展开态直出,只有用户点击切换才动(§14.4「该动才动」)。
 * - 展开:先挂载(0fr 帧提交)→ 下一帧切 1fr 起播。
 * - 收起:切 0fr 起播,transitionend(grid-template-rows)后卸载;另设
 *   fallback 定时器兜底——reduced-motion 的全局 `transition: none` 或过渡被
 *   中断时 transitionend 不会来,不能让 0fr 空壳悬挂。
 * - reduced-motion:展开/收起均瞬时(duration 0 + 立即卸载)。
 * - 退场冻结:收起动画期间渲染"最后一次展开态"的 children 快照——父组件
 *   可能在收起瞬间就按收起态重渲(置空数据),不冻结会让内容在动画中途
 *   被换掉;卸载时释放快照引用。
 *
 * 性能边界:grid-template-rows 是布局属性,只允许这种"用户触发、一次性、
 * 有明确终点"的瞬态动画(§14.4 红线);禁止用于常驻/循环动效。
 */

import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { useReducedMotion } from '@/hooks/useReducedMotion';

/** 收起卸载兜底(动画 200ms + 余量;transitionend 缺席时由它保证卸载)。 */
const COLLAPSE_UNMOUNT_FALLBACK_MS = 280;

interface CollapseProps extends React.HTMLAttributes<HTMLDivElement> {
  open: boolean;
  /** 追加在内层内容容器上的 class(外层 grid 容器用 className)。 */
  innerClassName?: string;
  children: React.ReactNode;
}

export function Collapse({ open, className, innerClassName, children, ...rest }: CollapseProps) {
  const reducedMotion = useReducedMotion();
  const [mounted, setMounted] = useState(open);
  const [expanded, setExpanded] = useState(open);
  // transitionend 可能在快速再展开后迟到,用最新 open 拦掉过期的卸载。
  const openRef = useRef(open);
  openRef.current = open;
  const isFirstRun = useRef(true);
  // 收起卸载兜底定时器:transitionend 正常到达时提前 clear,避免 280ms 时
  // 再来一次冗余 setMounted(false)(review 反馈;React 值不变不重渲,纯卫生)。
  const fallbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 退场冻结:收起动画期间父组件可能已按"收起态"重渲 children(典型:
  // WorkGroupBlock 收起后 activityProjection 置空,展开行瞬间被换成空内容,
  // review 反馈)。保留最后一次展开态的元素树,退场期渲染冻结帧,让内容
  // 完整地随高度收合;卸载时释放引用。
  const lastOpenChildrenRef = useRef<React.ReactNode>(open ? children : null);
  if (open) {
    lastOpenChildrenRef.current = children;
  }

  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return undefined;
    }
    if (open) {
      if (fallbackTimerRef.current !== null) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
      setMounted(true);
      if (reducedMotion) {
        setExpanded(true);
        return undefined;
      }
      const id = requestAnimationFrame(() => setExpanded(true));
      return () => cancelAnimationFrame(id);
    }
    setExpanded(false);
    if (reducedMotion) {
      setMounted(false);
      return undefined;
    }
    fallbackTimerRef.current = setTimeout(() => setMounted(false), COLLAPSE_UNMOUNT_FALLBACK_MS);
    return () => {
      if (fallbackTimerRef.current !== null) {
        clearTimeout(fallbackTimerRef.current);
        fallbackTimerRef.current = null;
      }
    };
  }, [open, reducedMotion]);

  if (!mounted) {
    lastOpenChildrenRef.current = null;
    return null;
  }

  return (
    <div
      {...rest}
      className={cn(
        'grid transition-[grid-template-rows] duration-[var(--motion-base,200ms)] ease-[var(--motion-ease-move,cubic-bezier(0.4,0,0.2,1))] motion-reduce:duration-0',
        expanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
        className,
      )}
      onTransitionEnd={(e) => {
        if (
          e.target === e.currentTarget &&
          e.propertyName === 'grid-template-rows' &&
          !openRef.current
        ) {
          if (fallbackTimerRef.current !== null) {
            clearTimeout(fallbackTimerRef.current);
            fallbackTimerRef.current = null;
          }
          setMounted(false);
        }
      }}
    >
      <div
        aria-hidden={!expanded || undefined}
        className={cn(
          'min-h-0 overflow-hidden',
          'transition-opacity duration-[var(--motion-base,200ms)] ease-[var(--motion-ease-move,cubic-bezier(0.4,0,0.2,1))] motion-reduce:duration-0',
          expanded ? 'opacity-100' : 'opacity-0',
          innerClassName,
        )}
      >
        {open ? children : lastOpenChildrenRef.current}
      </div>
    </div>
  );
}
