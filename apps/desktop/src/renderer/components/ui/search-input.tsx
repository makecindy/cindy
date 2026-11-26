/**
 * SearchInput —— 单行搜索框（DESIGN.md §4 Inputs & Forms，主人裁决 #1 A / #2，2026-11-23）。
 *
 * 在 Input 上固定四件事：32px 胶囊（Input sm）、13px 文字、14px 前置搜索图标，以及有内容时
 * 右侧的清空按钮（主人裁决 2026-11-27：清空是搜索框的标配，调用方不再自己写）。底色两档：
 * - `page`（默认）：页面、设置卡片、弹窗正文里，`--search-input-bg` 底（默认 = elevated），
 *   和 Input 同一套描边与焦点环；
 * - `panel`：菜单、浮层、下拉面板里，透明底，描边和文字跟面板（`--cmd-palette-*`），
 *   聚焦只加深描边（`--chat-input-border-focus`），不出蓝色焦点环。
 *
 * 清空按钮：有值、且不是 disabled / readOnly 时出现；点击调 `onChange('')` 和可选的
 * `onClear`，焦点回到输入框。按下时阻止默认行为，输入框不失焦，靠失焦收起的浮层不会被关掉；
 * 点击不再冒泡，不会被外层行或菜单当成别的操作。不加 Esc 清空（浮层里 Esc 是关闭）。
 *
 * 其余全部原样透传给内层 input：`role="combobox"`、`aria-activedescendant` 等 ARIA、
 * `onKeyDown`（输入法组字判断、方向键、回车、Esc 都由调用方处理）、`autoFocus`、
 * `inputRef`、`data-*`。`trailing` 在这里是排在清空按钮右侧的行内内容（组件负责定位并让出
 * 文字的右内边距），不需要调用方自己绝对定位。
 */

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Button } from './button';
import { Input, type InputProps } from './input';
import { Tip } from './tooltip';

export type SearchInputSurface = 'page' | 'panel';

export interface SearchInputProps extends Omit<
  InputProps,
  'size' | 'surface' | 'leading' | 'secret' | 'mono' | 'trailing'
> {
  /** `page`：页面上的 elevated 底（默认）；`panel`：菜单 / 浮层里的透明底。 */
  surface?: SearchInputSurface;
  /** 点内置清空按钮时、在 `onChange('')` 之后调用；需要额外复位（例如高亮项）时用。 */
  onClear?: () => void;
  /** 排在清空按钮右侧的行内内容（例如开关按钮），组件负责定位与让位。 */
  trailing?: ReactNode;
}

/**
 * page 档底色走独立的 `--search-input-bg`（默认 = `--surface-elevated`，外观与 Input 相同），
 * 以后统一调整搜索框底色（例如半透明）只改这一个 token。壁纸玻璃规则（globals.css）按类名
 * 同样覆盖它，和其它 elevated 底的表面一致。
 */
const PAGE_FIELD = 'bg-[var(--search-input-bg)]';

const PANEL_FIELD =
  'bg-transparent border-[var(--cmd-palette-border)] text-[var(--cmd-palette-item-text)] focus:border-[var(--chat-input-border-focus)] focus:ring-0';

const ICON_COLOR: Record<SearchInputSurface, string> = {
  page: 'text-[var(--text-tertiary)]',
  panel: 'text-[var(--cmd-palette-item-meta)]',
};

/** 清空图标与左侧搜索图标同色，悬停加深一档。 */
const CLEAR_COLOR: Record<SearchInputSurface, string> = {
  page: 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)]',
  panel: 'text-[var(--cmd-palette-item-meta)] hover:text-[var(--cmd-palette-item-text)]',
};

/** 文字与右侧控件之间留的空隙（px），和左侧图标到文字的间隔一致。 */
const TRAILING_GAP = 6;

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

export function SearchInput({
  surface = 'page',
  inputClassName,
  inputRef,
  onChange,
  onClear,
  trailing,
  style,
  ...rest
}: SearchInputProps) {
  const { t } = useTranslation();
  const field = useRef<HTMLInputElement | null>(null);
  const setField = useCallback(
    (node: HTMLInputElement | null) => {
      field.current = node;
      assignRef(inputRef, node);
    },
    [inputRef],
  );

  const showClear = rest.value.length > 0 && !rest.disabled && !rest.readOnly;
  const clearLabel = t('commonUi.clearSearch');

  const clear = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onChange('');
    onClear?.();
    field.current?.focus();
  };

  // 调用方另有 trailing 时，按实际宽度让出文字的右内边距；只有清空按钮时用 Input 自带的 pr-8。
  const group = useRef<HTMLSpanElement>(null);
  const [groupWidth, setGroupWidth] = useState(0);
  useLayoutEffect(() => {
    const node = group.current;
    if (!trailing || !node) {
      setGroupWidth(0);
      return;
    }
    const measure = () => setGroupWidth(node.offsetWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [trailing]);

  const clearButton = showClear ? (
    <Tip text={clearLabel}>
      <Button
        type="button"
        variant="secondary"
        tone="quiet"
        size="sm"
        className={cn('w-7 px-0', CLEAR_COLOR[surface])}
        aria-label={clearLabel}
        data-search-input-clear=""
        onMouseDown={(event) => event.preventDefault()}
        onClick={clear}
      >
        <X size={14} aria-hidden="true" />
      </Button>
    </Tip>
  ) : null;

  const trailingNode =
    clearButton || trailing ? (
      <span
        ref={group}
        className="absolute inset-y-0 right-0.5 flex items-center gap-0.5"
      >
        {clearButton}
        {trailing}
      </span>
    ) : undefined;

  return (
    <Input
      {...rest}
      size="sm"
      inputRef={setField}
      onChange={onChange}
      leading={<Search size={14} className={ICON_COLOR[surface]} />}
      trailing={trailingNode}
      style={trailing && groupWidth ? { ...style, paddingRight: groupWidth + 2 + TRAILING_GAP } : style}
      inputClassName={cn('text-13', surface === 'panel' ? PANEL_FIELD : PAGE_FIELD, inputClassName)}
    />
  );
}
