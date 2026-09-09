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

export interface ToastProps {
  item: ToastItem;
}

export function Toast({ item }: ToastProps) {
  const meta = VARIANT_MAP[item.variant];
  const Icon = meta.icon;

  return (
    <div
      role={meta.role}
      aria-live={meta.ariaLive}
      data-state={item.exiting ? 'exiting' : 'entering'}
      // hover 悬停时暂停自动关闭，移开后按剩余时长继续（正在阅读时不消失）
      onMouseEnter={() => toast.pauseAutoDismiss(item.id)}
      onMouseLeave={() => toast.resumeAutoDismiss(item.id)}
      className={cn(
        // 基础布局：单行 pill，内容驱动宽度
        'pointer-events-auto inline-flex items-center gap-2',
        // pill 外观：完全圆角 + Card + Board
        'rounded-full border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)]',
        // padding 对称
        'px-4 py-[10px]',
      )}
    >
      {/* Icon 16×16（彩色，硬编码内联 style） */}
      <Icon
        aria-hidden
        className="h-4 w-4 shrink-0"
        style={{ color: meta.color }}
        strokeWidth={2}
      />

      {/* 来源身份头（第三方供文案时宿主画:图标+名字,内容是谁说的一眼可辨） */}
      {item.source && (
        <span className="inline-flex shrink-0 items-center gap-1.5">
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

      {/* Message — 默认单行 nowrap, 但允许多行 (whitespace-pre-line) 给诊断类
          toast 用 (例如 silent install 失败时把 install log 尾巴拼进 message)。
          单行短文本仍然展示成一行不变化, 因为没有 \n 就不会换。 */}
      <span className="text-13 font-medium leading-snug text-[var(--cmd-palette-item-text)] whitespace-pre-line max-w-[480px] break-words">
        {item.message}
      </span>

      {item.action && (
        <button
          type="button"
          onClick={() => {
            try {
              item.action?.onClick();
            } finally {
              toast.dismiss(item.id);
            }
          }}
          className={cn(
            'ml-1 shrink-0 rounded-full px-2.5 py-1 text-12 font-medium',
            'text-[var(--text-primary)] transition-colors hover:bg-[var(--surface-hover)]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
          )}
        >
          {item.action.label}
        </button>
      )}
    </div>
  );
}
