import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { PluginDetailArticle, PluginDetailRecord, usePluginDetailLayout } from './PluginDetailRecord';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  PluginDetailHeader,
  PluginDetailFactsSection,
  PluginPermissionSummary,
  ToolsSection,
} from './GhostPluginDetailView';
import { PluginDetailTopBar, usePluginDetailScrolled } from './PluginDetailTopBar';
import { PLUGIN_MANAGEMENT_FRAME_CLASS } from './PluginManagementLayout';
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
  const layout = usePluginDetailLayout({
    id: `remote:${detail.id}`,
    ready: !loading,
    blocks: { description: Boolean(detail.description), permissions: Boolean(detail.permissions?.length), facts: true },
  });
  const facts = [
    // Older Hosts can send a top-level version alongside a partial fact list.
    ...(detail.version && !detail.details?.some(fact => fact.key === 'version')
      ? [{ key: 'version', label: t('settings.ghosts.detail.infoVersion'), value: `v${detail.version}` }]
      : []),
    ...(detail.details?.length
      ? detail.details.map((fact, index) => ({
          key: `${index}:${fact.key}`,
          label: fact.title,
          value: fact.value,
          monospace: fact.key === 'identifier',
          fullWidth: fact.key === 'location',
        }))
      : [{
          key: 'instance',
          label: t('settings.ghosts.remote.instanceId'),
          value: detail.id,
          monospace: true,
        }]),
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
      <PluginDetailArticle layout={layout} className={cn(PLUGIN_MANAGEMENT_FRAME_CLASS, 'plugin-detail-frame pb-16 pt-5')}>
        <PluginDetailHeader
          {...detail}
          fallbackFacts={{
            permissionCount: detail.permissions?.length,
            toolCount: detail.tools?.length,
            source: detail.details?.find(fact => fact.key === 'source')?.value,
          }}
          author={detail.details?.find((fact) => fact.key === 'author')?.value}
          enableControl={
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
        {!loading &&
        !failed &&
        (detail.tools === undefined ||
          detail.permissions === undefined ||
          !detail.details?.length) ? (
          <p className="mt-8 text-13 leading-5 text-[var(--text-tertiary)]">
            {t('settings.ghosts.remote.detailUnavailable')}
          </p>
        ) : null}
        <PluginDetailRecord key={detail.id}>
          {detail.permissions ? (
            <PluginPermissionSummary
              items={detail.permissions.map((permission, index) => ({
                key: String(index),
                title: permission.title,
                descriptions: [permission.description].filter(Boolean),
              }))}
            />
          ) : null}
          <PluginDetailFactsSection facts={facts}>
            {detail.tools ? <ToolsSection tools={detail.tools} /> : null}
          </PluginDetailFactsSection>
        </PluginDetailRecord>
      </PluginDetailArticle>
    </main>
  );
}
