/**
 * 设置的分区、卡片与行（DESIGN.md §4 Desktop settings rows）：组名在卡片外，一张卡片放多行、
 * 行间缩进分割线；行左边是名称与一行说明，右边是当前值、控件或进入下一页的箭头。整行可点时
 * 只有一个点击目标。名称 13/500、说明 12、当前值 13；文字行高用无单位比例，跟随
 * 「外观 → UI 字号」放大（DESIGN.md §3）：设置页名称 1.5、说明 1.4、两者间隔 4px，与没用组件的
 * 手写设置行一致；抽屉名称 1.38、间隔 2px。
 *
 * 设置页直接用：组名 h2，分区内的组名、卡片和说明间隔 14px。窄抽屉包在 SettingsDrawerScope 里，组名 h3、间隔 8px，
 * 行高收紧一档（行高 48，带头像 52），见 §4 Narrow drawer exception。
 */
import { createContext, useContext, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from 'react';
import { ChevronRight, Info } from 'lucide-react';

import { cn } from '@/lib/utils';

const DIVIDER_SHAPE = 'relative [&:not(:first-child)]:before:pointer-events-none [&:not(:first-child)]:before:absolute [&:not(:first-child)]:before:inset-x-4 [&:not(:first-child)]:before:h-px';
export const SETTINGS_DIVIDER = `${DIVIDER_SHAPE} [&:not(:first-child)]:before:top-0 [&:not(:first-child)]:before:bg-[var(--border-default)]`;
/**
 * 设置页的分割线跟卡片描边同一个 token，自定义主题单独改了设置卡片描边时一起生效；
 * 分割线占 1px 高度（画在行上方留出的 1px 里），与手写设置卡片里单独一行的分割线等高。
 */
const PAGE_DIVIDER = `${DIVIDER_SHAPE} [&:not(:first-child)]:mt-px [&:not(:first-child)]:before:-top-px [&:not(:first-child)]:before:bg-[var(--settings-theme-card-border)]`;
const PAGE_CARD = 'overflow-hidden rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)]';
const DRAWER_CARD = 'overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)]';
export const SETTINGS_HINT = 'text-12 leading-[1.4] text-[var(--text-secondary)] [text-wrap:pretty]';

/** 卡片标题这类不是设置行、但要和行名称同一档的文字（手柄页的卡片标题）。 */
export const SETTINGS_ROW_LABEL_CLASS = 'text-13 font-medium text-[var(--settings-section-sublabel)]';
/** 组名：SettingsSection 之外、结构特殊的分区标题（带计数或兄弟元素）也用它，和组件同一档。 */
export const SETTINGS_SECTION_TITLE_CLASS = 'text-16 font-medium leading-[1.2] text-[var(--settings-section-title)]';
/** 设置页的页面标题：比 16px 组名高一级（DESIGN.md §4）。没用 SettingsSection variant="page" 的手写页面标题用它。 */
export const SETTINGS_PAGE_TITLE_CLASS = 'text-20 font-medium leading-[1.3] text-[var(--settings-section-title)]';

const DrawerScope = createContext(false);
/** 在页面标题之下：里面的分区默认是 h3。 */
const PageScope = createContext(false);

export function SettingsDrawerScope({ children }: { children: ReactNode }) {
  return <DrawerScope.Provider value>{children}</DrawerScope.Provider>;
}

export function SettingsSection({ title, titleId, count, description, action, caption, children, testId, headingLevel, variant, className, ...rest }: {
  title?: ReactNode; count?: number; action?: ReactNode; caption?: ReactNode; children: ReactNode; testId?: string;
  /** 组名下面一行说明，紧贴组名；卡片下面的补充说明用 caption。 */
  description?: ReactNode;
  /** 组名元素的 id：设置搜索定位、aria-labelledby 指向组名时用。 */
  titleId?: string;
  /** 设置页的分区是 h2；抽屉、页面标题之下和页内的子分区是 h3。 */
  headingLevel?: 2 | 3;
  /** page：这一节的标题就是整页的页面标题，20px，下面 24px，里面的分区自动是 h3。 */
  variant?: 'page';
} & Omit<HTMLAttributes<HTMLElement>, 'title' | 'children'>) {
  const drawer = useContext(DrawerScope);
  const underPage = useContext(PageScope);
  const page = variant === 'page';
  const Heading = page ? 'h2' : (headingLevel ?? (drawer || underPage ? 3 : 2)) === 2 ? 'h2' : 'h3';
  const section = <section {...rest} className={cn('flex min-w-0 flex-col', page ? 'gap-6' : !drawer && 'gap-[14px]', className)} data-testid={testId}>
    {(title || action) && <div className={cn('flex items-center justify-between gap-3', (drawer || action) && 'min-h-6', drawer && 'mb-2')}>
      <div className="flex min-w-0 flex-col gap-1">
        <Heading id={titleId} className={cn('min-w-0', page ? SETTINGS_PAGE_TITLE_CLASS : drawer ? 'text-13 font-medium leading-[1.38] text-[var(--text-secondary)]' : SETTINGS_SECTION_TITLE_CLASS)}>
          {title}{count !== undefined && <span className="ml-1.5 font-normal tabular-nums text-[var(--text-tertiary)]">{count}</span>}
        </Heading>
        {description && <p className={cn(page ? 'text-13 leading-[1.5]' : 'text-12 leading-[1.45]', 'text-[var(--settings-section-desc)]')}>{description}</p>}
      </div>
      {action}
    </div>}
    {children}
    {caption && <p className={cn(drawer && 'mt-2', SETTINGS_HINT)}>{caption}</p>}
  </section>;
  return page ? <PageScope.Provider value>{section}</PageScope.Provider> : section;
}

export function SettingsCard({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const drawer = useContext(DrawerScope);
  return <div className={cn(drawer ? DRAWER_CARD : PAGE_CARD, className)} {...rest} />;
}

export interface SettingsRowProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title' | 'value'> {
  lead?: ReactNode;
  title: ReactNode;
  /** A small tag after the name, such as 「你」. */
  tag?: ReactNode;
  hint?: ReactNode;
  value?: ReactNode;
  chevron?: boolean;
  /** A control on the right; the row itself is then not a button. */
  trailing?: ReactNode;
  /** Rows with a 28–32px avatar. */
  media?: boolean;
  /** The control drops under the text when both cannot share a line. */
  wrap?: boolean;
  /** Outside a card, in a dialog that already has its own padding. */
  flush?: boolean;
  danger?: boolean;
  /** Rendered as a button when given. */
  onClick?: ButtonHTMLAttributes<HTMLButtonElement>['onClick'];
}

export function SettingsRow({ lead, title, tag, hint, value, chevron, trailing, media, wrap, flush, danger, onClick, disabled, className, ...rest }: SettingsRowProps) {
  const drawer = useContext(DrawerScope);
  const interactive = !!onClick;
  const body = <>
    {lead && <span className="flex shrink-0">{lead}</span>}
    <span className={cn('flex min-w-0 flex-col', wrap ? 'flex-[1_1_200px]' : 'flex-1')}>
      <span className={cn('flex min-w-0 items-baseline gap-1.5 text-13 font-medium', drawer ? 'leading-[1.38]' : 'leading-[1.5]', danger ? 'text-[var(--text-danger)]' : drawer ? 'text-[var(--text-primary)]' : 'text-[var(--settings-section-sublabel)]')}>
        <span className="min-w-0 [overflow-wrap:anywhere]">{title}</span>
        {tag && <span className="shrink-0 text-12 font-normal leading-[1.33] text-[var(--text-tertiary)]">{tag}</span>}
      </span>
      {hint && <span className={cn(drawer ? 'mt-0.5' : 'mt-1', SETTINGS_HINT)}>{hint}</span>}
    </span>
    {trailing ?? ((value !== undefined || chevron) && <span className="flex max-w-[55%] shrink-0 items-center gap-1 text-13 leading-[1.38] text-[var(--text-secondary)]">
      {value !== undefined && <span className="text-right [overflow-wrap:anywhere]">{value}</span>}
      {chevron && <ChevronRight size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />}
    </span>)}
  </>;
  const classes = cn(
    'flex w-full items-center gap-3 px-4 text-left', drawer ? SETTINGS_DIVIDER : PAGE_DIVIDER,
    media ? 'min-h-[52px] py-2' : drawer || flush ? 'min-h-12 py-3' : 'py-4',
    flush && 'px-0 [&:not(:first-child)]:before:inset-x-0',
    wrap && 'flex-wrap gap-y-2.5',
    disabled && 'opacity-60',
    className,
  );
  if (!interactive) return <div {...(rest as HTMLAttributes<HTMLDivElement>)} className={classes} aria-disabled={disabled || undefined}>{body}</div>;
  return <button type="button" {...rest} disabled={disabled} onClick={onClick} className={cn(classes,
    'outline-none transition-colors duration-[var(--motion-fast)] ease-[var(--motion-ease-out)] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring)]',
    !disabled && (danger ? 'hover:bg-[color-mix(in_srgb,var(--text-danger)_8%,transparent)]' : 'hover:bg-[var(--surface-hover)]'))}>{body}</button>;
}

/** 卡片里放不进「名称 + 控件」一行的内容（滑块、字体选择、预览）：同样的内边距和行间分割线。 */
export function SettingsBlock({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  const drawer = useContext(DrawerScope);
  return <div className={cn('px-4 py-4', drawer ? SETTINGS_DIVIDER : PAGE_DIVIDER, className)} {...rest} />;
}

/** A 32px round icon tile leading a row (群管理, AI 代答 without a teammate). */
export function SettingsRowIcon({ children }: { children: ReactNode }) {
  return <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--surface-chip)] text-[var(--text-secondary)]">{children}</span>;
}

/** A one-paragraph state notice (archived, dissolved, only you left). */
export function SettingsNotice({ children, tone = 'info', action }: { children: ReactNode; tone?: 'info' | 'error'; action?: ReactNode }) {
  const drawer = useContext(DrawerScope);
  return <div role={tone === 'error' ? 'alert' : undefined} className={cn(drawer ? DRAWER_CARD : PAGE_CARD, 'flex gap-2.5 px-3.5 py-3 text-13 leading-[1.54] text-[var(--text-primary)]')}>
    <Info size={16} aria-hidden className={cn('mt-0.5 shrink-0', tone === 'error' ? 'text-[var(--text-danger)]' : 'text-[var(--text-tertiary)]')} />
    <div className="min-w-0 flex-1">{children}{action && <div className="mt-2 flex gap-2">{action}</div>}</div>
  </div>;
}
