import { RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';

/** 正式版布局恢复入口：复用 main 的原子 reset + broadcast，不另存 renderer 状态。 */
export function LayoutResetControl() {
  const { t } = useTranslation();
  const [resetting, setResetting] = useState(false);

  const handleReset = async (): Promise<void> => {
    if (resetting) return;
    setResetting(true);
    try {
      const result = await window.electronAPI.layout.reset();
      if (result.persisted) {
        toast.success(t('settings.appearance.layout.resetSuccess'));
      } else {
        toast.error(t('settings.appearance.layout.resetFailed'));
      }
    } catch {
      toast.error(t('settings.appearance.layout.resetFailed'));
    } finally {
      setResetting(false);
    }
  };

  return (
    <div
      className={cn(
        'flex items-center justify-between gap-3 rounded-xl p-5',
        'bg-[var(--settings-theme-card-bg)]',
        'border border-[var(--settings-theme-card-border)]',
      )}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p
          className="text-13 font-medium text-[var(--settings-section-sublabel)]"
          style={{ letterSpacing: '0.12px' }}
        >
          {t('settings.appearance.layout.label')}
        </p>
        <p className="text-12 leading-[1.4] text-[var(--settings-section-sublabel)] opacity-70">
          {t('settings.appearance.layout.hint')}
        </p>
      </div>

      <button
        type="button"
        onClick={() => void handleReset()}
        disabled={resetting}
        aria-label={t('settings.appearance.layout.reset')}
        className={cn(
          'flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-12 font-medium',
          'border border-[var(--settings-input-border)]',
          'bg-[var(--settings-input-bg)] text-[var(--settings-input-text)]',
          'transition-colors hover:bg-[var(--settings-menu-bg-hover)]',
          'disabled:cursor-wait disabled:opacity-60',
        )}
      >
        <RotateCcw size={14} aria-hidden />
        {t('settings.appearance.layout.reset')}
      </button>
    </div>
  );
}
