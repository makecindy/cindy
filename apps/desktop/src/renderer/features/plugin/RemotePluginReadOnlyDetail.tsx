import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  PluginDetailHeader,
  PluginDetailFactsSection,
  PluginPermissionSummary,
  ToolsSection,
} from './GhostPluginDetailView';
import { PluginDetailTopBar, usePluginDetailScrolled } from './PluginDetailTopBar';
import type { LegacyManagedPluginDetail } from './remotePluginManagementClient';

export function RemotePluginReadOnlyDetail({
  detail,
  notice,
  loading,
  failed,
  online,
  onBack,
  onRetry,
}: {
  detail: LegacyManagedPluginDetail;
  notice: ReactNode;
  loading: boolean;
  failed: boolean;
  online: boolean;
  onBack(): void;
  onRetry(): void;
}) {
  const { t } = useTranslation();
  const { scrolled, onScroll } = usePluginDetailScrolled();
  const facts = detail.details?.length
    ? detail.details.map((fact, index) => ({
        key: `${index}:${fact.key}`,
        label: fact.title,
        value: fact.value,
        monospace: fact.key === 'identifier',
        fullWidth: fact.key === 'location',
      }))
    : [
        ...(detail.version
          ? [
              {
                key: 'version',
                label: t('settings.ghosts.detail.infoVersion'),
                value: `v${detail.version}`,
              },
            ]
          : []),
        {
          key: 'instance',
          label: t('settings.ghosts.remote.instanceId'),
          value: detail.id,
          monospace: true,
        },
      ];
  return (
    <main
      className="app-wallpaper-surface plugin-motion-root h-full min-h-0 w-full overflow-y-auto bg-[var(--surface)] [scrollbar-gutter:stable_both-edges]"
      onScroll={onScroll}
    >
      <PluginDetailTopBar
        label={t('settings.ghosts.detail.backToList')}
        onBack={onBack}
        scrolled={scrolled}
      />
      <article className="plugin-detail-frame mx-auto w-full max-w-[824px] px-8 pb-16 pt-5 max-[760px]:px-6">
        <PluginDetailHeader
          {...detail}
          author={detail.details?.find((fact) => fact.key === 'author')?.value}
          actions={
            detail.enabled !== undefined ? (
              <span className="text-12 leading-5 text-[var(--text-secondary)]">
                {t(
                  detail.enabled
                    ? 'settings.ghosts.detail.enabledLabel'
                    : 'settings.ghosts.detail.disabledLabel',
                )}
              </span>
            ) : undefined
          }
        >
          <div className="mt-5">{notice}</div>
        </PluginDetailHeader>
        {loading ? (
          <p role="status" className="text-13 leading-5 text-[var(--text-secondary)]">
            {t('settings.ghosts.remote.detailLoading')}
          </p>
        ) : null}
        {failed ? (
          <div
            role="status"
            className="flex flex-wrap items-center gap-3 text-13 leading-5 text-[var(--text-secondary)]"
          >
            <p>{t('settings.ghosts.remote.detailReadFailed')}</p>
            <Button size="sm" variant="secondary" disabled={!online} onClick={onRetry}>
              {t('settings.ghosts.remote.refreshDetail')}
            </Button>
          </div>
        ) : null}
        {detail.tools?.length ? <ToolsSection tools={detail.tools} /> : null}
        {detail.permissions?.length ? (
          <PluginPermissionSummary
            items={detail.permissions.map((permission, index) => ({
              key: String(index),
              title: permission.title,
              descriptions: [permission.description].filter(Boolean),
            }))}
          />
        ) : null}
        {!loading &&
        !failed &&
        (detail.tools === undefined ||
          detail.permissions === undefined ||
          !detail.details?.length) ? (
          <p className="mt-8 text-13 leading-5 text-[var(--text-tertiary)]">
            {t('settings.ghosts.remote.detailUnavailable')}
          </p>
        ) : null}
        <PluginDetailFactsSection facts={facts} />
      </article>
    </main>
  );
}
