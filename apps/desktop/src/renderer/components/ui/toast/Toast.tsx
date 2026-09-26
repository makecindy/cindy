import { Button } from '@/components/ui/button';
import { CircleCheck, CircleX, Info, LoaderCircle, TriangleAlert, type LucideIcon } from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';
import { toast, type ToastItem, type ToastVariant } from '@/lib/toast';

interface VariantMeta {
  icon: LucideIcon;
  color: string;
  role: 'status' | 'alert';
  ariaLive: 'polite' | 'assertive';
}

export const VARIANT_MAP: Record<ToastVariant, VariantMeta> = {
  // E5D 定稿 2026-07-17(Toast 豁免解除):info/success/warning/error 四色定稿,跨主题一致
  loading: {
    icon: LoaderCircle,
    color: 'var(--text-secondary)',
    role: 'status',
    ariaLive: 'polite',
  },
  info: {
    icon: Info,
    color: '#417CDD',
    role: 'status',
    ariaLive: 'polite',
  },
  success: {
    icon: CircleCheck,
    color: '#2AAE5B',
    role: 'status',
    ariaLive: 'polite',
  },
  warning: {
    icon: TriangleAlert,
    color: '#F3A115',
    role: 'status',
    ariaLive: 'polite',
  },
  error: {
    icon: CircleX,
    color: '#D91F37',
    role: 'alert',
    ariaLive: 'assertive',
  },
};

export interface ToastProps {
  item: ToastItem;
}

export function Toast({ item }: ToastProps) {
  const meta = VARIANT_MAP[item.variant];
  const Icon = meta.icon;
  const panelRef = useRef<HTMLDivElement>(null);
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
        hovering.current = true;
        toast.pauseAutoDismiss(item.id);
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
        multiline ? 'rounded-xl' : 'rounded-full',
        'border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
        // padding 对称
        'px-4 py-[10px]',
      )}
    >
      {item.variant === 'loading' ? (
        <Spinner size={16} strokeWidth={2} aria-hidden style={{ color: meta.color }} />
      ) : (
        <Icon
          aria-hidden
          className="h-4 w-4 shrink-0"
          style={{ color: meta.color }}
          strokeWidth={2}
        />
      )}

      <span ref={messageRef} className="min-w-0 max-w-[480px] text-13 font-medium leading-snug text-[var(--cmd-palette-item-text)] whitespace-pre-line [overflow-wrap:anywhere]">
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
          <span aria-hidden className="text-13 leading-snug text-[var(--text-tertiary)] opacity-60">
            ·
          </span>
        </span>
      )}

      {/* Preserve diagnostic newlines and allow unbroken URLs to fit. */}
        {item.message}
      </span>

      {item.action && (
        <Button
          variant="secondary"
          size="sm"
          compact
          type="button"
          onClick={() => {
            try {
              item.action?.onClick();
            } finally {
              toast.dismiss(item.id);
            }
          }}
          className="ml-1 h-auto min-h-7 max-w-[40%] whitespace-normal [overflow-wrap:anywhere] py-1"
        >
          {item.action.label}
        </Button>
      )}
    </div>
  );
}
