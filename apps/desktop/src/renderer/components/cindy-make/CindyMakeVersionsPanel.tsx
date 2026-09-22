import { useEffect, useId, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { useCindyVersions } from '@/lib/useCindyVersions';
import type { CindyVersionInfo, CindyVersionsState } from '../../../shared/cindyVersions';

/** One overview: the running app first, followed by its personal source. */
export function CindyMakeVersionsPanel({
  active = true,
  busy = false,
  refreshKey,
  onState,
  children,
}: {
  active?: boolean;
  busy?: boolean;
  refreshKey?: string;
  onState?: (state?: CindyVersionsState) => void;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const versions = useCindyVersions(active, refreshKey);
  const { confirm } = useConfirmDialog();
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const disabled = busy || !!versions.pending || versions.state?.switching;
  const supported = typeof window.electronAPI.getCindyVersions === 'function';
  useEffect(() => onState?.(versions.state), [onState, versions.state]);
  const current =
    versions.state?.currentVersion ??
    versions.state?.versions.find((version) => version.id === versions.state?.currentId);
  const alternatives =
    versions.state?.versions.filter((version) => version.id !== versions.state?.currentId) ?? [];
  const title = (version: CindyVersionInfo) =>
    version.kind === 'original'
      ? t('cindyMake.versions.original')
      : t('cindyMake.versions.personal');
  const personal = versions.state?.versions.find((version) => version.kind === 'personal');
  const switchBlockedReason = (version: CindyVersionInfo) => {
    if (disabled) return 'busy' as const;
    if (!version.available) return 'unavailable' as const;
    if (!version.compatible) return 'incompatible' as const;
    return undefined;
  };
  const switchBlockedLabel = (version: CindyVersionInfo) => {
    const reason = switchBlockedReason(version);
    if (!reason) return undefined;
    return t(reason === 'busy' ? 'cindyMake.versions.errors.busy' : 'cindyMake.versions.' + reason);
  };
  const renderSwitchButton = (version: CindyVersionInfo, actionLabel: string) => {
    const blockedLabel = switchBlockedLabel(version);
    return (
      <Button
        variant="secondary"
        disabled={!!switchBlockedReason(version)}
        loading={versions.pending === version.id}
        onClick={() => void versions.act('switch', version.id)}
        title={blockedLabel}
        aria-label={blockedLabel ?? actionLabel}
      >
        {blockedLabel ?? actionLabel}
      </Button>
    );
  };
  const metadata = (version: CindyVersionInfo, includeDate = false) =>
    [
      version.development ? t('cindyMake.versions.development') : null,
      version.kind === 'original' ? version.version : null,
      version.commit?.slice(0, 12),
      version.dirty ? t('cindyMake.versions.localChanges') : null,
      includeDate && version.builtAt && Number.isFinite(Date.parse(version.builtAt))
        ? new Date(version.builtAt).toLocaleString(i18n.language)
        : null,
    ]
      .filter(Boolean)
      .join(' · ');
  return (
    <section
      aria-label={t('cindyMake.overview.title')}
      className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] text-[var(--text-primary)]"
    >
      {supported && (
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0 flex-[1_1_280px]">
              <h3 className="flex flex-wrap items-baseline gap-2 text-13 font-normal">
                <span className="text-[var(--text-secondary)]">
                  {t('cindyMake.versions.current')}
                </span>
                {current && (
                  <span className="break-words">
                    {current.kind === 'personal'
                      ? t('cindyMake.versions.personal')
                      : title(current)}
                  </span>
                )}
              </h3>
              {current ? (
                <p className="mt-1 break-words text-12 text-[var(--text-secondary)]">
                  {metadata(current)}
                </p>
              ) : (
                <p className="mt-1 text-13 text-[var(--text-secondary)]">
                  {t('settings.cindyMake.checking')}
                </p>
              )}
            </div>
            {!!alternatives.length && (
              <Button
                variant="secondary"
                className="gap-2"
                aria-expanded={expanded}
                aria-controls={listId}
                onClick={() => setExpanded(!expanded)}
              >
                {t('cindyMake.overview.switchVersion')}
                {expanded ? (
                  <ChevronUp size={14} aria-hidden />
                ) : (
                  <ChevronDown size={14} aria-hidden />
                )}
              </Button>
            )}
            {versions.state &&
              !versions.state.versions.some((version) => version.kind === 'personal') && (
                <p className="text-12 text-[var(--text-tertiary)]">
                  {t('cindyMake.versions.empty')}
                </p>
              )}
          </div>
          {versions.state?.personalUpdateAvailable && personal && (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="text-12 text-[var(--text-secondary)]">
                <p>{metadata(personal, true)}</p>
                {(!personal.available || !personal.compatible) && (
                  <p>
                    {t(
                      !personal.available
                        ? 'cindyMake.versions.unavailable'
                        : 'cindyMake.versions.incompatible',
                    )}
                  </p>
                )}
              </div>
              {renderSwitchButton(personal, t('cindyMake.versions.updatePersonal'))}
            </div>
          )}
          {versions.error && (
            <p role="alert" className="text-12 text-[var(--error-fg)]">
              {t('cindyMake.versions.errors.' + versions.error)}
            </p>
          )}
          {expanded && !!alternatives.length && (
            <div id={listId} className="space-y-2 border-t border-[var(--border-default)] pt-3">
              <p className="text-12 text-[var(--text-secondary)]">
                {t('cindyMake.versions.description')}
              </p>
              <ul className="max-h-60 divide-y divide-[var(--border-default)] overflow-y-auto overscroll-contain">
                {alternatives.map((version) => (
                  <li
                    key={version.id}
                    className="flex flex-wrap items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-13 font-medium">{title(version)}</p>
                      <p className="mt-1 break-words text-12 text-[var(--text-secondary)]">
                        {metadata(version, true)}
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
                      {renderSwitchButton(version, t('cindyMake.versions.switch'))}
                      {version.kind === 'personal' && (
                        <Button
                          variant="secondary"
                          disabled={disabled || versions.state?.selectedId === version.id}
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
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}
