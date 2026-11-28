/**
 * FileFilterInput —— 文件名筛选输入框(Codex Cmd+P 风格)。
 *
 * 常驻挂在 sidebar 文件树上方,空值显示文件树,有输入则由 caller 切换到
 * `FilterResultList`。
 *
 * 视觉:共享 SearchInput(32px 胶囊、14px 搜索图标,有内容时右侧是它内置的清空按钮)。
 *
 * 抽到 workdir-browse/ 下,RSB plugin 和 doc 模式 sidebar 共用。
 */

import { useTranslation } from 'react-i18next';

import { SearchInput } from '@/components/ui/search-input';
import gitChangesIcon from '@/assets/giticon.svg';
import { cn } from '@/lib/utils';

export interface FileFilterInputProps {
  placeholder?: string;
  value: string;
  onChange: (next: string) => void;
  changedOnly?: boolean;
  onToggleChangedOnly?: () => void;
}

export function FileFilterInput({
  value,
  onChange,
  placeholder,
  changedOnly = false,
  onToggleChangedOnly,
}: FileFilterInputProps) {
  const { t } = useTranslation();
  // padding 上 12 / 下 8(2026-07-01 用户:下面再小 1/3,12 → 8):
  //   - 上间距 = TreeHeader pb-1(4) + Input pt-2(8) = 12
  //   - 下间距 = Input pb-0(0) + FileTreeView / FilterResultList 自带 py-2(8) = 8
  // 不对称是有意的:上面接 chrome,留出标题与筛选框的视觉断层;下面紧贴文件树
  // 列表,更紧凑,符合"筛选输入 → 即将看到的结果"的连续阅读节奏。
  const label = placeholder ?? t('rightSidebar.fileBrowser.filterPlaceholder');
  return (
    <div className="shrink-0 px-3 pt-2">
        <SearchInput
          value={value}
          onChange={onChange}
          placeholder={label}
          aria-label={label}
          trailing={
            onToggleChangedOnly && (
              <button
                type="button"
                aria-label={t('rightSidebar.fileBrowser.changedOnly')}
                aria-pressed={changedOnly}
                title={t('rightSidebar.fileBrowser.changedOnly')}
                onClick={onToggleChangedOnly}
                className={cn(
                  'flex size-7 shrink-0 items-center justify-center rounded-lg border border-[var(--border-default)]',
                  'text-sidebar-action-icon transition-colors hover:bg-sidebar-item-active hover:text-sidebar-item-active-foreground',
                  'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--focus-ring)]',
                  changedOnly && 'bg-sidebar-item-active text-sidebar-item-active-foreground',
                )}
              >
                <span
                  aria-hidden
                  className="size-[13px] bg-current"
                  style={{
                    maskImage: `url("${gitChangesIcon}")`,
                    maskPosition: 'center',
                    maskRepeat: 'no-repeat',
                    maskSize: 'contain',
                  }}
                />
              </button>
            )
          }
        />
    </div>
  );
}
