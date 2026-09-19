import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useCindyVersions } from '@/lib/useCindyVersions';

export function CindyMakeVersionsPanel({
  active = true,
  busy = false,
  refreshKey,
}: {
  active?: boolean;
  busy?: boolean;
  refreshKey?: string;
}) {
  const { t, i18n } = useTranslation();
  const versions = useCindyVersions(active, refreshKey);
  const { confirm } = useConfirmDialog();
  const disabled = busy || !!versions.pending || versions.state?.switching;
  if (typeof window.electronAPI.getCindyVersions !== 'function') return null;
  return (
    <section className="rounded-xl border border-[var(--settings-theme-card-border)] bg-[var(--settings-theme-card-bg)] p-5">
      <h3 className="text-14 font-medium text-[var(--text-primary)]">
        {t('cindyMake.versions.title')}
      </h3>
      <p className="mt-1 text-12 text-[var(--text-secondary)]">
        {t('cindyMake.versions.description')}
      </p>
      {versions.error && (
        <p role="alert" className="mt-2 text-12 text-[var(--status-danger)]">
          {t('cindyMake.versions.errors.' + versions.error)}
        </p>
      )}
      <div className="mt-3 divide-y divide-[var(--border-default)]">
        {versions.state?.versions.map((version) => {
          const current = versions.state?.currentId === version.id;
          const title =
            version.kind === 'original'
              ? t('cindyMake.versions.original')
              : version.title || t('cindyMake.versions.personal');
          const date =
            version.builtAt && Number.isFinite(Date.parse(version.builtAt))
              ? new Date(version.builtAt).toLocaleString(i18n.language)
              : '';
          return (
            <div
              key={version.id}
              className="flex flex-wrap items-center justify-between gap-3 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-13 font-medium text-[var(--text-primary)]">
                  {title}
                  {current && (
                    <span className="ml-2 text-12 text-[var(--text-secondary)]">
                      {t('cindyMake.versions.current')}
                    </span>
                  )}
                </p>
                <p className="mt-1 text-12 text-[var(--text-secondary)]">
                  {[
                    version.development ? t('cindyMake.versions.development') : null,
                    version.version,
                    date,
                    version.commit?.slice(0, 12),
                    version.dirty ? t('cindyMake.versions.localChanges') : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
                {(!version.available || !version.compatible) && (
                  <p className="mt-1 text-12 text-[var(--text-secondary)]">
                    {t(
                      !version.available
                        ? 'cindyMake.versions.unavailable'
                        : 'cindyMake.versions.incompatible',
                    )}
                  </p>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  disabled={disabled || current || !version.available || !version.compatible}
                  loading={versions.pending === version.id}
                  onClick={() => void versions.act('switch', version.id)}
                >
                  {t(current ? 'cindyMake.versions.using' : 'cindyMake.versions.switch')}
                </Button>
                {version.kind === 'personal' && (
                  <Button
                    variant="secondary"
                    disabled={disabled || current || versions.state?.selectedId === version.id}
                    onClick={async () => {
                      if (
                        await confirm({
                          title: t('cindyMake.versions.removeTitle'),
                          description: t('cindyMake.versions.removeDescription'),
                          confirmText: t('cindyMake.versions.remove'),
                          confirmVariant: 'destructive',
                        })
                      )
                        await versions.act('remove', version.id);
                    }}
                  >
                    {t('cindyMake.versions.remove')}
                  </Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {versions.state?.versions.length === 1 && (
        <p className="text-12 text-[var(--text-secondary)]">{t('cindyMake.versions.empty')}</p>
      )}
    </section>
  );
}
