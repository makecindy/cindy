import { CircleCheck, CircleX, Info, TriangleAlert, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toast, type ToastItem, type ToastVariant } from '@/lib/toast';

interface VariantMeta {
  icon: LucideIcon;
  color: string;
  role: 'status' | 'alert';
  ariaLive: 'polite' | 'assertive';
}

export const VARIANT_MAP: Record<ToastVariant, VariantMeta> = {
  // E5D 定稿 2026-07-17(Toast 豁免解除):info/success/warning/error 四色定稿,跨主题一致
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

/** 无 source 时用 variant 作为副文本标签 */
function variantLabel(v: ToastVariant): string {
  switch (v) {
    case 'info': return 'Info';
    case 'success': return 'Success';
    case 'warning': return 'Warning';
    case 'error': return 'Error';
  }
}

export interface ToastProps {
  item: ToastItem;
}

export function Toast({ item }: ToastProps) {
  const meta = VARIANT_MAP[item.variant];
  const Icon = meta.icon;

  // 副文本：有 source 时显示来源名，否则用 variant 名称作为标签
  const subtitle = item.source?.name ?? variantLabel(item.variant);

  return (
    <div
      role={meta.role}
      aria-live={meta.ariaLive}
      data-state={item.exiting ? 'exiting' : 'entering'}
      onMouseEnter={() => toast.pauseAutoDismiss(item.id)}
      onMouseLeave={() => toast.resumeAutoDismiss(item.id)}
      className={cn(
        'pointer-events-auto flex gap-3 w-fit rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
        'px-4 py-3',
      )}
    >
      <div className="shrink-0 mt-0.5">
        <Icon
          aria-hidden
          className="h-4 w-4"
          style={{ color: meta.color }}
          strokeWidth={2}
        />
      </div>
      <div className="flex-1 min-w-0">
        <div
          className="text-sm font-medium leading-snug text-[var(--cmd-palette-item-text)] whitespace-pre-line max-w-[480px] break-words"
        >
          {item.message}
        </div>
        <div className="mt-1 inline-flex items-center gap-1.5">
          {item.source?.iconDataUrl && (
            <img
              src={item.source.iconDataUrl}
              alt=""
              draggable={false}
              className="h-3.5 w-3.5 rounded-[4px] object-cover"
            />
          )}
          <span className="text-xs leading-snug text-[var(--text-tertiary)]">
            {subtitle}
          </span>
        </div>
      </div>
    </div>
  );
}
