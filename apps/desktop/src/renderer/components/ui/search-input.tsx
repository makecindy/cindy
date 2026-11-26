/**
 * SearchInput —— 单行搜索框（DESIGN.md §4 Inputs & Forms，主人裁决 #1 A / #2，2026-11-23）。
 *
 * 在 Input 上固定三件事：32px 胶囊（Input sm）、13px 文字、14px 前置搜索图标。底色两档：
 * - `page`（默认）：页面、设置卡片、弹窗正文里，elevated 底，和 Input 同一套描边与焦点环；
 * - `panel`：菜单、浮层、下拉面板里，透明底，描边和文字跟面板（`--cmd-palette-*`），
 *   聚焦只加深描边（`--chat-input-border-focus`），不出蓝色焦点环。
 *
 * 其余全部原样透传给内层 input：`role="combobox"`、`aria-activedescendant` 等 ARIA、
 * `onKeyDown`（输入法组字判断、方向键、回车、Esc 都由调用方处理）、`autoFocus`、
 * `inputRef`、`data-*`。组件本身不拦截任何按键，也不加清空按钮——需要时用 `trailing`。
 */

import { Search } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Input, type InputProps } from './input';

export type SearchInputSurface = 'page' | 'panel';

export interface SearchInputProps extends Omit<
  InputProps,
  'size' | 'surface' | 'leading' | 'secret' | 'mono'
> {
  /** `page`：页面上的 elevated 底（默认）；`panel`：菜单 / 浮层里的透明底。 */
  surface?: SearchInputSurface;
}

const PANEL_FIELD =
  'bg-transparent border-[var(--cmd-palette-border)] text-[var(--cmd-palette-item-text)] focus:border-[var(--chat-input-border-focus)] focus:ring-0';

const ICON_COLOR: Record<SearchInputSurface, string> = {
  page: 'text-[var(--text-tertiary)]',
  panel: 'text-[var(--cmd-palette-item-meta)]',
};

export function SearchInput({ surface = 'page', inputClassName, ...rest }: SearchInputProps) {
  return (
    <Input
      {...rest}
      size="sm"
      leading={<Search size={14} className={ICON_COLOR[surface]} />}
      inputClassName={cn('text-13', surface === 'panel' && PANEL_FIELD, inputClassName)}
    />
  );
}
