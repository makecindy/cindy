import { Zap } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * Fast 模式开关 —— lightning + "Fast" 文案 + 小型 toggle。
 *
 * 视觉与状态完全无关于具体宿主：聊天输入框（ChatInput）和创建自动化面板
 * （ScheduleFormDialog）共用同一个组件，保证两处 Fast 开关像素一致。
 * 仅在 agent 支持 Fast（codex）且当前模型 supportsFastMode 时由宿主决定是否渲染。
 *
 * `hideIcon`: 隐藏前缀闪电图标（模型选择器 Edit 配置列里用 —— 那里已有「选项」分组语境，
 * 不需要图标重复提示）。默认 false，其它宿主像素不变。
 */
export function FastModeToggle({
  enabled,
  onToggle,
  hideIcon = false,
  accentVar = 'var(--status-bar-accent)',
  thumbVar,
}: {
  enabled: boolean;
  onToggle: () => void;
  hideIcon?: boolean;
  /** 开启态的强调色(图标 / "Fast" 文案 / 轨道)。默认品牌橙;模型选择器传单色 token 以遵循设计稿。 */
  accentVar?: string;
  /** 滑钮颜色。缺省 = 白色(`bg-white`);传入则按主题 token 上色(深色主题下深钮)。 */
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
      aria-label="Fast Mode"
      aria-pressed={enabled}
    >
      {!hideIcon && (
        <Zap
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
        Fast
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
