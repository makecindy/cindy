import { Brain } from 'lucide-react';

import { cn } from '@/lib/utils';

/** 思考开关：视觉对齐 FastModeToggle，仅开/关两档的模型使用。 */
export function ThinkingToggle({
  enabled,
  onToggle,
  label,
  hideIcon = false,
  accentVar = 'var(--status-bar-accent)',
  thumbVar,
}: {
  enabled: boolean;
  onToggle: () => void;
  label: string;
  hideIcon?: boolean;
  accentVar?: string;
  thumbVar?: string;
}) {
  const trackW = 28;
  const trackH = 16;
  const thumbSize = 12;
  const thumbInset = 2;
  const color = enabled ? accentVar : undefined;

  return (
    <button
      type="button"
      className={cn(
        'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2',
        'bg-transparent transition-colors hover:bg-[var(--model-trigger-hover)]',
      )}
      onClick={onToggle}
      aria-label={label}
      aria-pressed={enabled}
    >
      {!hideIcon && (
        <Brain
          size={14}
          className={cn('shrink-0', !enabled && 'text-[var(--fast-toggle-off)]')}
          style={{
            color: enabled ? color : undefined,
            transform: 'translateY(-1px)',
          }}
        />
      )}
      <span
        className={cn(
          'text-13 font-normal leading-none',
          !enabled && 'text-[var(--fast-toggle-off)]',
        )}
        style={enabled ? { color } : undefined}
      >
        {label}
      </span>
      <span
        className="relative shrink-0 rounded-full transition-colors duration-150"
        style={{
          width: trackW,
          height: trackH,
          backgroundColor: enabled ? accentVar : 'var(--fast-toggle-track)',
        }}
      >
        <span
          className={cn(
            'absolute rounded-full transition-transform duration-150',
            !thumbVar && 'bg-white',
          )}
          style={{
            width: thumbSize,
            height: thumbSize,
            top: thumbInset,
            left: thumbInset,
            transform: enabled ? `translateX(${trackW - thumbSize - thumbInset * 2}px)` : 'translateX(0)',
            ...(thumbVar ? { backgroundColor: thumbVar } : {}),
          }}
        />
      </span>
    </button>
  );
}
