/**
 * Button —— DESIGN.md §4 三变体标准控件（primary / secondary / cta）。
 *
 * 升格自 ProvidersSection 的 PillButton / CtaPillButton。圆角一律胶囊（§5）。
 * 高度 28/32/36px；22/24px 仅用于紧凑场景，不设 40px 档。
 * hover 走换色 token，禁用透明度 hover（G2）。pressed 进最低状态矩阵（G3）。
 * hover / pressed 由 colors.ts 的 color-mix 派生（见那里的注释）：暗色下
 * surface-hover 与 surface-chip 同值，直接 alias 会让悬停不可见。
 * 字号字重 text-13 / 500（G4）。secondary 绑 Tier-1，不继承 settings 域 alias（G5）。
 *
 * 禁用态指针遵循既有「禁用统一普通指针」裁决（#3246）：class 仍写
 * disabled:cursor-not-allowed，globals.css 把它收成普通箭头。
 *
 * loading 仅表达调用方持有的进行中状态；不执行请求或改变提交语义。
 */

import * as React from 'react';

import { cn } from '@/lib/utils';
import { Spinner } from './spinner';
import './button.css';

export type ButtonVariant = 'primary' | 'secondary' | 'cta';
export type ButtonSize = 'xxs' | 'xs' | 'sm' | 'md' | 'lg';
export type ButtonTone = 'default' | 'quiet' | 'danger' | 'danger-solid' | 'danger-surface';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  tone?: ButtonTone;
  /** Retain existing confirmation-dialog theme overrides in one shared place. */
  palette?: 'default' | 'confirmation' | 'permission';
  /** Tighter horizontal padding for toolbars, rows and narrow panels. */
  compact?: boolean;
  /** Hide the visible label while busy; retain its accessible name and width. */
  loading?: boolean;
  /** A progress-view action may remain usable while its operation runs. */
  allowWhileLoading?: boolean;
  /** Select triggers and excluded input controls retain their stationary frame. */
  pressFeedback?: boolean;
}

// Paint overrides must use --button-face-bg / --button-face-border (including
// hover/active variants), not background/border-color on the hitbox. These are
// component-local aliases of existing semantic tokens, not new theme settings.

const SIZE_STYLES: Record<ButtonSize, string> = {
  xxs: 'h-[22px]',
  xs: 'h-6',
  sm: 'h-7',
  md: 'h-8',
  lg: 'h-9',
};

// Semantic treatments share the same face, focus, disabled and motion contract.
const TONE_STYLES: Record<ButtonTone, string> = {
  default: '',
  quiet:
    '[--button-face-bg:transparent] [--button-face-border:transparent] text-[var(--text-secondary)] enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:var(--button-secondary-hover)] enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:var(--button-secondary-pressed)]',
  danger:
    '[--button-face-bg:transparent] [--button-face-border:transparent] text-[var(--text-danger)] enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:color-mix(in_srgb,var(--text-danger)_12%,transparent)] enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:color-mix(in_srgb,var(--text-danger)_20%,transparent)]',
  // Inline confirmations cover text beneath them; keep an opaque themed face.
  'danger-surface':
    '[--button-face-bg:color-mix(in_srgb,hsl(var(--destructive))_15%,var(--surface-elevated))] [--button-face-border:transparent] text-[hsl(var(--destructive))] enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:color-mix(in_srgb,hsl(var(--destructive))_25%,var(--surface-elevated))] enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:color-mix(in_srgb,hsl(var(--destructive))_35%,var(--surface-elevated))]',
  'danger-solid':
    '[--button-face-bg:hsl(var(--destructive))] [--button-face-border:hsl(var(--destructive))] text-[var(--accent-pure-cta-fg)] enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:color-mix(in_srgb,hsl(var(--destructive))_90%,var(--text-primary))] enabled:[&:not([aria-disabled=true])]:hover:[--button-face-border:color-mix(in_srgb,hsl(var(--destructive))_90%,var(--text-primary))] enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:color-mix(in_srgb,hsl(var(--destructive))_80%,var(--text-primary))] enabled:[&:not([aria-disabled=true])]:active:[--button-face-border:color-mix(in_srgb,hsl(var(--destructive))_80%,var(--text-primary))]',
};

/**
 * hover / active 一律带 `enabled:` 前缀。CSS 的 :hover 对 disabled 元素照样匹配，
 * 不加前缀时禁用按钮鼠标悬停仍会换底色（globals.css 只把禁用态指针收成普通箭头，
 * 不管背景）—— 旧的 PillButton 完全没有 hover，所以这属迁移引入的行为回归。
 */
const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: [
    '[--button-face-border:var(--surface-chip)] [--button-face-bg:var(--surface-chip)] text-[var(--text-primary)]',
    'enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:var(--button-primary-hover)] enabled:[&:not([aria-disabled=true])]:hover:[--button-face-border:var(--button-primary-hover)]',
    'enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:var(--button-primary-pressed)] enabled:[&:not([aria-disabled=true])]:active:[--button-face-border:var(--button-primary-pressed)]',
  ].join(' '),
  secondary: [
    '[--button-face-border:var(--border-default)] [--button-face-bg:var(--surface-elevated)] text-[var(--text-primary)]',
    'enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:var(--button-secondary-hover)]',
    'enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:var(--button-secondary-pressed)]',
  ].join(' '),
  cta: [
    '[--button-face-border:var(--accent-cta-bg-pure)] [--button-face-bg:var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]',
    'enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:var(--button-cta-hover)] enabled:[&:not([aria-disabled=true])]:hover:[--button-face-border:var(--button-cta-hover)]',
    'enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:var(--button-cta-pressed)] enabled:[&:not([aria-disabled=true])]:active:[--button-face-border:var(--button-cta-pressed)]',
  ].join(' '),
};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      tone = 'default',
      palette = 'default',
      compact = false,
      type = 'button',
      disabled,
      loading = false,
      allowWhileLoading = false,
      pressFeedback = true,
      children,
      ...props
    },
    ref,
  ) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled || (loading && !allowWhileLoading)}
      aria-busy={loading || undefined}
      data-press-feedback={pressFeedback && !loading ? undefined : 'none'}
      className={cn(
        'cindy-button cindy-button-frame inline-flex shrink-0 items-center justify-center gap-1.5 rounded-full border border-transparent px-6 text-13 font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        SIZE_STYLES[size],
        VARIANT_STYLES[variant],
        palette === 'confirmation' &&
          (variant === 'secondary'
            ? '[--button-face-border:var(--confirm-btn-secondary-border)] [--button-face-bg:transparent] text-[var(--confirm-btn-secondary-text)] enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:var(--confirm-btn-secondary-hover)] enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:var(--confirm-btn-secondary-hover)]'
            : '[--button-face-border:transparent] [--button-face-bg:var(--confirm-btn-primary-bg)] text-[var(--confirm-btn-primary-text)] enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:var(--confirm-btn-primary-hover)] enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:var(--confirm-btn-primary-hover)]'),
        palette === 'permission' &&
          '[--button-face-border:transparent] [--button-face-bg:var(--perm-allow-btn-bg)] text-[var(--perm-allow-btn-text)] enabled:[&:not([aria-disabled=true])]:hover:[--button-face-bg:color-mix(in_srgb,var(--perm-allow-btn-bg)_92%,var(--perm-allow-btn-text))] enabled:[&:not([aria-disabled=true])]:active:[--button-face-bg:color-mix(in_srgb,var(--perm-allow-btn-bg)_82%,var(--perm-allow-btn-text))]',
        TONE_STYLES[tone],
        compact && 'px-3',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    >
      {loading ? (
        <span className="inline-flex items-center justify-center gap-[inherit] opacity-0">
          {children}
        </span>
      ) : (
        children
      )}
      {loading && (
        <span aria-hidden="true" className="absolute inset-0 flex items-center justify-center">
          <Spinner size={14} />
        </span>
      )}
    </button>
  ),
);
Button.displayName = 'Button';

export { Button };
