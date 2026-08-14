/**
 * FileFilterInput —— 文件名筛选输入框(Codex Cmd+P 风格)。
 *
 * 常驻挂在 sidebar 文件树上方,空值显示文件树,有输入则由 caller 切换到
 * `FilterResultList`。
 *
 * 视觉:h-7 圆角矩形,左侧 Search 图标,右侧 X 清除按钮(有内容时显示),边框
 * focus 时高亮 ring。
 *
 * 抽到 workdir-browse/ 下,RSB plugin 和 doc 模式 sidebar 共用。
 */

import { Search, X as XIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

export interface FileFilterInputProps {
  value: string;
  onChange: (next: string) => void;
}

export function FileFilterInput({ value, onChange }: FileFilterInputProps) {
  const { t } = useTranslation();
  // padding 上 12 / 下 8(2026-07-01 用户:下面再小 1/3,12 → 8):
  //   - 上间距 = TreeHeader pb-1(4) + Input pt-2(8) = 12
  //   - 下间距 = Input pb-0(0) + FileTreeView / FilterResultList 自带 py-2(8) = 8
  // 不对称是有意的:上面接 chrome,留出标题与筛选框的视觉断层;下面紧贴文件树
  // 列表,更紧凑,符合"筛选输入 → 即将看到的结果"的连续阅读节奏。
  return (
    <div className="shrink-0 px-3 pt-2">
      <div className="relative">
        <Search
          size={12}
          strokeWidth={2}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-sidebar-action-icon"
        />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={t('rightSidebar.fileBrowser.filterPlaceholder')}
          className={cn(
            'h-7 w-full rounded-md border border-[var(--border-default)] bg-[var(--surface-elevated)]',
            'pl-7 pr-7 text-12 text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)]',
            'outline-none transition-colors',
            'focus:border-[var(--focus-ring)] focus:ring-1 focus:ring-[var(--focus-ring-soft)]',
          )}
        />
        {value && (
          <button
            type="button"
            onClick={() => onChange('')}
            aria-label={t('rightSidebar.fileBrowser.filterClear')}
            className="absolute right-1 top-1/2 -translate-y-1/2 flex size-5 items-center justify-center rounded text-sidebar-action-icon hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground"
          >
            <XIcon size={12} strokeWidth={2} />
          </button>
        )}
      </div>
    </div>
  );
}
