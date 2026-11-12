import { ConfettiBurst } from '@/components/ui/ConfettiBurst';
import { Button } from '@/components/ui/button';
import { Star, X, CircleCheck, CircleX, Info, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast, type ToastItem, type ToastVariant, type ToastActionPoint } from '@/lib/toast';

interface VariantMeta {
  icon: LucideIcon;
  color: string;
  role: 'status' | 'alert';
  ariaLive: 'polite' | 'assertive';
}

export const VARIANT_MAP: Record<ToastVariant, VariantMeta> = {
  // E5D 定稿 2026-07-17:info/success/warning/error 四色与全局状态色同值;2026-11-11 维护者裁决
  // (A-15)改走对应 token,调整状态色时 Toast 自动同步,不再写死 hex。
  loading: {
    icon: LoaderCircle,
    color: 'var(--text-secondary)',
    role: 'status',
    ariaLive: 'polite',
  },
  info: {
    icon: Info,
    color: 'var(--focus-ring)',
    role: 'status',
    ariaLive: 'polite',
  },
  success: {
    icon: CircleCheck,
    color: 'var(--card-status-done)',
    role: 'status',
    ariaLive: 'polite',
  },
  warning: {
    icon: TriangleAlert,
    color: 'var(--warning-fg)',
    role: 'status',
    ariaLive: 'polite',
  },
  error: {
    icon: CircleX,
    color: 'var(--card-status-error)',
    role: 'alert',
    ariaLive: 'assertive',
  },
};

export interface ToastProps {
  item: ToastItem;
  /** Interactive content, such as a disclosure, in place of the plain message. */
  message?: React.ReactNode;
}

export function Toast({ item, message }: ToastProps) {
  const meta = VARIANT_MAP[item.variant];
  const Icon = item.icon === 'star' ? Star : meta.icon;
  const panelRef = useRef<HTMLDivElement>(null);
  const [actionWidth, setActionWidth] = useState<number>();
  const celebrated = useRef(false);
  const [celebrationOrigin, setCelebrationOrigin] = useState<ToastActionPoint | null>(null);
  useLayoutEffect(() => {
    if (item.celebrate && item.variant === 'success' && !item.exiting && !celebrated.current) {
      celebrated.current = true;
      const rect = panelRef.current?.getBoundingClientRect();
      setCelebrationOrigin(item.celebrationOrigin ?? {
        x: rect ? rect.left + rect.width / 2 : window.innerWidth / 2,
        y: rect ? rect.top + rect.height / 2 : window.innerHeight / 2,
      });
    }
  }, [item.celebrate, item.variant, item.exiting, item.celebrationOrigin]);
  const messageRef = useRef<HTMLSpanElement>(null);
  const [multiline, setMultiline] = useState(false);
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const message = messageRef.current;
    if (!panel || !message) return;
    const measure = () => {
      const lineHeight = Number.parseFloat(getComputedStyle(message).lineHeight);
      const action = panel.querySelector('button');
      const actionStyle = action && getComputedStyle(action);
      const actionWraps = action && actionStyle
        ? action.clientHeight > Number.parseFloat(actionStyle.lineHeight)
          + Number.parseFloat(actionStyle.paddingTop) + Number.parseFloat(actionStyle.paddingBottom) + 1
        : false;
      setMultiline(message.getBoundingClientRect().height > lineHeight + 1 || Boolean(actionWraps));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(panel);
    return () => observer.disconnect();
  }, [item.message, item.source?.name, item.action?.label]);
  const hovering = useRef(false);
  const focused = useRef(false);
  const resumeIfIdle = () => {
    if (!hovering.current && !focused.current) toast.resumeAutoDismiss(item.id);
  };

  return (
    <div
      ref={panelRef}
      role={meta.role}
      aria-live={meta.ariaLive}
      data-state={item.exiting ? 'exiting' : 'entering'}
      // Hover and keyboard focus independently pause the remaining duration.
      onMouseEnter={() => {
        hovering.current = item.pauseOnHover !== false;
        if (hovering.current) toast.pauseAutoDismiss(item.id);
      }}
      onMouseLeave={() => {
        hovering.current = false;
        resumeIfIdle();
      }}
      onFocusCapture={() => {
        focused.current = true;
        toast.pauseAutoDismiss(item.id);
      }}
      onBlurCapture={(event) => {
        if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
        focused.current = false;
        resumeIfIdle();
      }}
      className={cn(
        // Short messages stay compact; long content and actions wrap within the viewport.
        'pointer-events-auto inline-flex max-w-full items-center gap-2',
        // Multiline notifications are content containers; short notifications keep the pill.
        multiline || item.title ? 'rounded-xl' : 'rounded-full',
        item.title && 'relative w-96 flex-wrap gap-x-3 pr-10',
        item.placement === 'top-right' && 'shadow-[shadow:var(--shadow-menu)]',
        'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
        // padding 对称
        'px-4 py-[10px]',
      )}
    >
      <span className="inline-flex shrink-0">
      {item.variant === 'loading' ? (
        <Spinner size={16} strokeWidth={2} aria-hidden style={{ color: meta.color }} />
      ) : (
        <Icon
          aria-hidden
          className="h-4 w-4 shrink-0"
          style={{ color: item.icon === 'star' ? 'var(--text-secondary)' : meta.color }}
          strokeWidth={2}
        />
      )}

      </span>
      {celebrationOrigin && !item.exiting && (
        <ConfettiBurst origin={celebrationOrigin} zIndex={10101} onDone={() => setCelebrationOrigin(null)} />
      )}

      <span ref={messageRef} className="flex-1 min-w-0 max-w-[480px] text-13 font-medium leading-snug text-[var(--cmd-palette-item-text)] whitespace-pre-line [overflow-wrap:anywhere]">
      {/* 来源身份头（第三方供文案时宿主画:图标+名字,内容是谁说的一眼可辨） */}
      {item.source && (
        <span className="mr-2 inline-flex max-w-full items-center gap-1.5 align-bottom">
          {item.source.iconDataUrl && (
            <img
              src={item.source.iconDataUrl}
              alt=""
              draggable={false}
              className="h-4 w-4 rounded-[4px] object-cover"
            />
          )}
          <span className="max-w-[160px] truncate text-13 font-medium leading-snug text-[var(--text-tertiary)]">
            {item.source.name}
          </span>
          <span aria-hidden className="text-13 leading-snug text-[var(--text-tertiary)]">
            ·
          </span>
        </span>
      )}

      {/* Preserve diagnostic newlines and allow unbroken URLs to fit. */}
        {item.title && <span className="mb-1 block text-14 font-medium">{item.title}</span>}
        <span className={item.title ? 'text-[var(--text-secondary)] font-normal' : undefined}>{message ?? item.message}</span>
      </span>

      {item.dismissLabel && (
        <button type="button" aria-label={item.dismissLabel} title={item.dismissLabel}
          className="absolute right-1 top-1 flex size-8 items-center justify-center rounded-full text-[var(--text-secondary)] hover:bg-[var(--button-secondary-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
          onClick={() => toast.dismiss(item.id)}><X size={14} aria-hidden /></button>
      )}
      <div className={item.title ? 'flex w-full flex-wrap justify-end items-center gap-2' : 'contents'}>
      {item.dismissLabel && <Button variant="secondary" tone="quiet" size="sm" onClick={() => toast.dismiss(item.id)}>{item.dismissLabel}</Button>}
      {item.action && (
        <Button
          variant={item.action.emphasis ?? (item.title ? "primary" : "secondary")}
          size="sm"
          compact
          type="button"
          disabled={item.action.disabled}
          style={actionWidth ? { width: actionWidth, maxWidth: '100%', flexShrink: 0 } : undefined}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            if (item.title && item.action?.keepOpen) setActionWidth(rect.width);
            const point = event.detail > 0
              ? { x: event.clientX, y: event.clientY }
              : { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
            try {
              item.action?.onClick(point);
            } finally {
              if (!item.action?.keepOpen) toast.dismiss(item.id);
            }
          }}
          className={cn('ml-1 h-auto min-h-7 whitespace-normal [overflow-wrap:anywhere] py-1', !item.title && 'max-w-[40%]')}
        >
          {item.action.label}
        </Button>
      )}
      </div>
    </div>
  );
}
