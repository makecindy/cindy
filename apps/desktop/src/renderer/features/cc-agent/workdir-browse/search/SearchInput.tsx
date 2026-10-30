/**
 * SearchInput — 文件搜索输入框
 *
 * Specs:
 *   container:   h:30  cornerRadius:6  padding [0, 4, 0, 10]  gap:4
 *                fill:#ffffff (Light)/#2c2c2a (Dark)  stroke:#d7d7d4/#3c3c3a 1px
 *   input text:  Inter 13 / 500 / #262626 (Light) / #ffffff (Dark)
 *   placeholder: Silver / Mid Gray (token: muted-foreground)
 *   Toggles container: gap:2  alignItems:center
 *   Aa toggle:   22×22  cornerRadius:4
 *                off → 文字 #737373 / Inter 11 / 600,无 bg
 *                on  → fill:#e5e5e5 (Light) / #363634 (Dark) 文字 #262626/#ffffff
 *
 * 不带"清空 X 按钮" — 设计稿没有,Esc 键就能清。
 */

import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Tip } from '@/components/ui/tooltip';

export interface SearchInputProps {
  value: string;
  onChange: (next: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (next: boolean) => void;
  /** 用户按 ESC 时调用,清空输入。 */
  onClear: () => void;
}

export function SearchInput({
  value,
  onChange,
  caseSensitive,
  onCaseSensitiveChange,
  onClear,
}: SearchInputProps) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'flex h-[30px] w-full items-center gap-1',
        'rounded-md border border-sidebar-border bg-background',
        'pl-2.5 pr-1',
        'focus-within:border-foreground/40',
      )}
    >
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            onClear();
          }
        }}
        placeholder={t('ccAgent.workdirBrowse.searchPanel.placeholderSearch')}
        // data-attr 是给 doc 模式 Ctrl+Shift+F 跨组件 focus 用的钩子 —— 见
        // WorkdirBrowseSidebar 的 'workdir-open-project-search' 监听。
        data-workdir-search-input=""
        className={cn(
          'min-w-0 flex-1 bg-transparent text-13 font-medium text-foreground',
          'placeholder:font-normal placeholder:text-[var(--text-placeholder)]',
          'focus:outline-none',
        )}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
      <Tip text={caseSensitive ? t('ccAgent.workdirBrowse.searchPanel.matchCaseOn') : t('ccAgent.workdirBrowse.searchPanel.matchCaseOff')}>
        <button
          type="button"
          onClick={() => onCaseSensitiveChange(!caseSensitive)}
          aria-label={t('ccAgent.workdirBrowse.searchPanel.matchCaseAria')}
          aria-pressed={caseSensitive}
          className={cn(
            'flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-[4px] px-1',
            'text-11 font-semibold leading-none transition-colors',
            caseSensitive
              ? 'bg-sidebar-item-active text-sidebar-item-active-foreground'
              : 'text-sidebar-muted hover:bg-sidebar-item-hover hover:text-foreground',
          )}
        >
          Aa
        </button>
      </Tip>
    </div>
  );
}
