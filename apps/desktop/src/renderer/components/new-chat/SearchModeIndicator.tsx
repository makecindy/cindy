/**
 * 搜索模式激活态 chip（composer 上方，与 PlanModeIndicator 同形）。
 */

import { Globe2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface SearchModeIndicatorProps {
  onExit: () => void;
  disabled?: boolean;
}

export function SearchModeIndicator({
  onExit,
  disabled,
}: SearchModeIndicatorProps): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div
      className="mx-auto flex max-w-full select-none items-center gap-2 rounded-lg px-2.5 py-1.5 text-12"
      style={{
        backgroundColor: 'var(--surface-chip)',
        border: '1px solid var(--border-default)',
      }}
    >
      <Globe2
        size={13}
        strokeWidth={2}
        aria-hidden
        className="shrink-0"
        style={{ color: 'var(--text-secondary)' }}
      />
      <span className="shrink-0 font-medium" style={{ color: 'var(--text-secondary)' }}>
        {t('searchMode.indicator.title')}
      </span>
      <span className="min-w-0 flex-1 truncate" style={{ color: 'var(--text-tertiary)' }}>
        {t('searchMode.indicator.hint')}
      </span>
      {!disabled && (
        <button
          type="button"
          aria-label={t('searchMode.exit')}
          title={t('searchMode.exit')}
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--surface-elevated)]"
          style={{ color: 'var(--text-tertiary)' }}
          onClick={onExit}
        >
          <X size={12} strokeWidth={2} />
        </button>
      )}
    </div>
  );
}
