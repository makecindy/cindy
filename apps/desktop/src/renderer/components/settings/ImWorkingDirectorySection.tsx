import { FolderOpen } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';

/**
 * IM 渠道「新对话工作目录」区块 — 个人微信/企业微信共用。
 *
 * 目录只能经 Main 原生选择器进入(点击整行触发),Renderer 不提供路径输入;
 * i18n key 前缀由渠道注入(`settings.wechatBot` / `settings.wecomBot`),组件
 * 只消费 `<prefix>.workingDir.*` 与渠道各自的提示文案。
 */
export function ImWorkingDirectorySection({
  i18nKeyPrefix,
  settings,
  pending,
  onChoose,
  onReset,
}: {
  i18nKeyPrefix: string;
  settings: { workingDir: string | null; workingDirAvailable: boolean } | null;
  pending: boolean;
  onChoose: () => void;
  onReset: () => void;
}) {
  const { t } = useTranslation();
  const configured = settings?.workingDir ?? null;

  return (
    <section className="flex flex-col gap-3" aria-label={t(`${i18nKeyPrefix}.workingDir.title`)}>
      <div>
        <h3 className="text-13 font-medium text-[var(--settings-section-title)]">
          {t(`${i18nKeyPrefix}.workingDir.title`)}
        </h3>
        <p className="mt-1 text-12 leading-[1.55] text-[var(--settings-section-desc)]">
          {t(`${i18nKeyPrefix}.workingDir.hint`)}
        </p>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onChoose}
          disabled={pending}
          aria-label={
            configured
              ? t(`${i18nKeyPrefix}.workingDir.chooseAriaWithDir`, { dir: configured })
              : t(`${i18nKeyPrefix}.workingDir.chooseAria`)
          }
          className={cn(
            'flex h-10 min-w-0 flex-1 items-center gap-2 rounded-full px-3 text-left',
            'border border-[var(--settings-input-border)] bg-[var(--settings-input-bg)]',
            'text-12 text-[var(--settings-input-text)]',
            'transition-colors hover:border-[var(--settings-input-border-focus)]',
            'active:scale-[0.98]',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset',
            'focus-visible:ring-[var(--focus-ring-soft)]',
            pending && 'cursor-not-allowed opacity-50',
          )}
        >
          <FolderOpen size={15} className="shrink-0 text-[var(--text-tertiary)]" />
          <span className="truncate" title={configured ?? undefined} dir="auto">
            {configured ?? t(`${i18nKeyPrefix}.workingDir.managed`)}
          </span>
        </button>
        {configured && (
          <button
            type="button"
            onClick={onReset}
            disabled={pending}
            className={cn(
              'h-10 shrink-0 rounded-full px-4 text-12 font-medium',
              'border border-[var(--settings-btn-secondary-border)] bg-[var(--settings-btn-secondary-bg)]',
              'text-[var(--settings-btn-secondary-text)] transition-colors',
              'hover:bg-[var(--surface-hover)] active:scale-[0.98]',
              'focus-visible:outline-none focus-visible:ring-2',
              'focus-visible:ring-[var(--focus-ring-soft)]',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
          >
            {t(`${i18nKeyPrefix}.workingDir.reset`)}
          </button>
        )}
      </div>
      {settings && !settings.workingDirAvailable && (
        <p className="text-12 text-[var(--settings-error-text)]" role="alert">
          {t(`${i18nKeyPrefix}.workingDir.unavailable`)}
        </p>
      )}
    </section>
  );
}
