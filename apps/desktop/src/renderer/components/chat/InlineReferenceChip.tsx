/**
 * Shared visual shell for atomic references in the composer and sent messages.
 *
 * The shell owns the pill geometry, theme tokens and truncation tooltip.
 * Callers keep semantic behaviour such as navigation, file preview and
 * ProseMirror drag handling. Atomic chips intentionally have no close button;
 * composer nodes remain removable through normal node selection + Delete.
 *
 * 剪贴板契约(为什么这里是 `<span role="button">` 而不是 `<button>`):
 *   聊天消息被选中复制时,Chromium 会把选区**原样**序列化进 `text/html`。
 *   `<button>` 是交互控件,不属于任何富文本内容模型,外部编辑器(Slack /
 *   飞书 / Notion / Word)解析粘贴的 HTML 时按标签白名单走,会把整个节点
 *   连同内部文字一起丢弃,并在原位留下一个断行——用户看到的就是"文件名
 *   凭空消失"。`<span>` 在所有这些白名单里,文字能完整落地。
 *   同理 `user-select: none` 会让文字连 `text/plain` 都进不了剪贴板,所以
 *   它只对 composer 的 ProseMirror atomic node 开启,见 `textSelectable`。
 */
import type { KeyboardEventHandler, MouseEventHandler, ReactNode, Ref } from 'react';

import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export interface InlineReferenceChipProps {
  label: string;
  icon?: ReactNode;
  tooltip?: ReactNode;
  tooltipMono?: boolean;
  tooltipContentClassName?: string;
  selected?: boolean;
  onClick?: MouseEventHandler<HTMLSpanElement>;
  onContextMenu?: MouseEventHandler<HTMLSpanElement>;
  chipRef?: Ref<HTMLSpanElement>;
  ariaLabel?: string;
  className?: string;
  labelClassName?: string;
  /** 标记会话路由动作，分屏 pane 不应在点击前抢走路由主权。 */
  splitPaneRouteAction?: boolean;
  /**
   * chip 文字能否被 selection 选中并进入剪贴板。默认 `true`——已发送消息里的
   * chip 必须能跟着正文一起复制出去。composer 里的 ProseMirror atomic node 传
   * `false`:那里 chip 是一个整体被选中 / 删除的原子节点,内部文字不参与 selection。
   */
  textSelectable?: boolean;
}

/** Theme-aware 12px reference pill with a formal full-content tooltip. */
export function InlineReferenceChip({
  label,
  icon,
  tooltip = label,
  tooltipMono = false,
  tooltipContentClassName,
  selected = false,
  onClick,
  onContextMenu,
  chipRef,
  ariaLabel,
  className,
  labelClassName,
  splitPaneRouteAction = false,
  textSelectable = true,
}: InlineReferenceChipProps) {
  const interactive = Boolean(onClick || onContextMenu);
  const sharedClassName = cn(
    'inline-flex min-w-0 max-w-full items-center',
    !textSelectable && 'select-none',
    'gap-1.5 rounded-full border px-2 py-0.5 text-[12px] font-normal leading-5',
    'bg-[var(--surface-chip)] text-[var(--text-primary)]',
    // 下划线跟着 `interactive` 一起给:DESIGN.md §14.5 要求「下划线 ⇔ 可点」双向成立,
    // 而本组件同时服务可点的会话 / 项目深链 chip 与不可点的静态 chip(sidebar-embedded
    // 等不注入 onClick / onContextMenu 的调用点)。判据只有 `interactive` 这一处,
    // cursor 与下划线同源,不可能一边有一边没有(PR #1144 review 实捉:改前这些 chip
    // 有 onClick 却无下划线,是「可点但无下划线」的反例)。
    interactive && 'cursor-pointer underline underline-offset-2 transition-colors hover:bg-[var(--surface-hover)]',
    className,
  );
  const style = {
    borderColor: selected ? 'var(--focus-ring)' : 'var(--border-default)',
  };
  const contents = (
    <>
      {icon ? (
        <span
          aria-hidden
          className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5"
        >
          {icon}
        </span>
      ) : null}
      <span className={cn('min-w-0 truncate', labelClassName)}>{label}</span>
    </>
  );
  // `<span role="button">` 换掉原生 `<button>` 后要自己补键盘激活:走 native
  // click(),让 onClick 收到一个正常的合成鼠标事件,调用方无需区分入口。
  const handleKeyDown: KeyboardEventHandler<HTMLSpanElement> = (e) => {
    if (!onClick) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.currentTarget.click();
  };
  const trigger = (
    <span
      ref={chipRef}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-label={ariaLabel}
      onClick={onClick}
      onContextMenu={onContextMenu}
      onKeyDown={interactive ? handleKeyDown : undefined}
      className={sharedClassName}
      style={style}
      data-inline-reference-chip=""
      data-split-pane-route-action={splitPaneRouteAction ? '' : undefined}
    >
      {contents}
    </span>
  );

  return (
    <Tip
      text={tooltip}
      mono={tooltipMono}
      delay={300}
      contentClassName={tooltipContentClassName}
    >
      {trigger}
    </Tip>
  );
}
