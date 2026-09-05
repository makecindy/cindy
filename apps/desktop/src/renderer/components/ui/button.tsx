/**
 * Button —— DESIGN.md §4 三变体标准控件（primary / secondary / cta）。
 *
 * 升格自 ProvidersSection 的 PillButton / CtaPillButton。圆角一律胶囊（§5）。
 * 高度双档 32/36px，不设 40（DS-4 G1，拍板人 = 用户/设计师，2026-09-03）。
 * hover 走换色 token，禁用透明度 hover（G2）。pressed 进最低状态矩阵（G3）。
 * hover / pressed 由 colors.ts 的 color-mix 派生（见那里的注释）：暗色下
 * surface-hover 与 surface-chip 同值，直接 alias 会让悬停不可见。
 * 字号字重 text-13 / 500（G4）。secondary 绑 Tier-1，不继承 settings 域 alias（G5）。
 *
 * 禁用态指针遵循既有「禁用统一普通指针」裁决（#3246）：class 仍写
 * disabled:cursor-not-allowed，globals.css 把它收成普通箭头。
 *
 * loading 首批调用点未用到，本张不做。
 */

import * as React from 'react';

import { cn } from '@/lib/utils';

export type ButtonVariant = 'primary' | 'secondary' | 'cta';
export type ButtonSize = 'md' | 'lg';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
}

const SIZE_STYLES: Record<ButtonSize, string> = {
  md: 'h-8',
  lg: 'h-9',
};

/**
 * hover / active 一律带 `enabled:` 前缀。CSS 的 :hover 对 disabled 元素照样匹配，
 * 不加前缀时禁用按钮鼠标悬停仍会换底色（globals.css 只把禁用态指针收成普通箭头，
 * 不管背景）—— 旧的 PillButton 完全没有 hover，所以这属迁移引入的行为回归。
 */
const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: [
    'border border-[var(--surface-chip)] bg-[var(--surface-chip)] text-[var(--text-primary)]',
    'enabled:hover:bg-[var(--button-primary-hover)] enabled:hover:border-[var(--button-primary-hover)]',
    'enabled:active:bg-[var(--button-primary-pressed)] enabled:active:border-[var(--button-primary-pressed)]',
  ].join(' '),
  secondary: [
    'border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)]',
    'enabled:hover:bg-[var(--button-secondary-hover)]',
    'enabled:active:bg-[var(--button-secondary-pressed)]',
  ].join(' '),
  cta: [
    'border border-[var(--accent-cta-bg-pure)] bg-[var(--accent-cta-bg-pure)] text-[var(--accent-pure-cta-fg)]',
    'enabled:hover:bg-[var(--button-cta-hover)] enabled:hover:border-[var(--button-cta-hover)]',
    'enabled:active:bg-[var(--button-cta-pressed)] enabled:active:border-[var(--button-cta-pressed)]',
  ].join(' '),
};

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = 'primary', size = 'md', type = 'button', disabled, ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      disabled={disabled}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full px-6 text-13 font-medium transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
        SIZE_STYLES[size],
        VARIANT_STYLES[variant],
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  ),
);
Button.displayName = 'Button';

export { Button };
