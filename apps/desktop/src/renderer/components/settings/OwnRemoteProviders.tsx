/**
 * 设置 → 模型供应商里「自己其他电脑上能用的供应商」：同账号、在线、允许远程控制的电脑上，
 * 打开了「允许被远程调用」且已连接的供应商——也就是模型列表里能选的那些远程供应商。
 *
 * 与本机供应商同在左栏，图标右上角带远程角标(与模型列表同一个 RemoteSourceMark)；点开在
 * 右栏只读地看它在哪台电脑、开放了哪些模型。修改要到那台电脑上去，这里不提供开关。
 */
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProviderView } from '@cindy/model-providers';

import { hasProviderLogo, ProviderLogoMark } from '@/components/icons/ProviderLogoMark';
import { RemoteSourceMark } from '@/components/icons/RemoteSourceMark';
import { remoteAgentProviders } from '@/components/new-chat/unifiedModelSelection';
import { Tip } from '@/components/ui/tooltip';
import { useControllableDevices } from '@/hooks/useControllableDevices';
import { useDevicesProviders } from '@/hooks/useDevicesProviders';
import { providerDisplayName } from '@/lib/providerDisplayName';
import { providerMonogram } from '@/lib/providerModels';
import { cn } from '@/lib/utils';

import { ReadOnlyProviderModelSection, readOnlyProviderModels } from './ReadOnlyProviderModels';

export interface OwnRemoteProvider {
  /** 左栏选中态的键。 */
  key: string;
  deviceId: string;
  deviceName: string;
  provider: ProviderView;
  modelVisibilityOverrides?: Record<string, boolean>;
}

export function ownRemoteProviderKey(deviceId: string, providerId: string): string {
  return `${deviceId}\n${providerId}`;
}

/** 在线的同账号电脑上可以远程使用的供应商，按电脑、再按那台电脑的供应商顺序排列。 */
export function useOwnRemoteProviders(): readonly OwnRemoteProvider[] {
  const devices = useControllableDevices();
  const deviceIds = useMemo(() => devices.map((device) => device.deviceId), [devices]);
  const catalogs = useDevicesProviders(deviceIds);
  return useMemo(
    () =>
      devices.flatMap((device) => {
        const catalog = catalogs.get(device.deviceId);
        if (!catalog) return [];
        return remoteAgentProviders(catalog.providers)
          .filter((provider) => provider.connected && !provider.suspended)
          .map((provider) => ({
            key: ownRemoteProviderKey(device.deviceId, provider.id),
            deviceId: device.deviceId,
            deviceName: device.name,
            provider,
            ...(catalog.modelVisibilityOverrides !== undefined
              ? { modelVisibilityOverrides: catalog.modelVisibilityOverrides }
              : {}),
          }));
      }),
    [catalogs, devices],
  );
}

function RemoteProviderIcon({ provider, size }: { provider: ProviderView; size: number }) {
  return (
    <RemoteSourceMark markSize={size}>
      {hasProviderLogo(provider.id, provider.routing) ? (
        <ProviderLogoMark providerId={provider.id} routing={provider.routing} size={size} />
      ) : (
        <span className="text-15 font-medium leading-none">{providerMonogram(provider.name)}</span>
      )}
    </RemoteSourceMark>
  );
}

/** 左栏里的远程供应商行：与本机供应商同一行式，接在它们下面、不参与拖动排序；所在电脑只写在悬停提示里。 */
export function OwnRemoteProviderRows({
  entries,
  selectedKey,
  onSelect,
}: {
  entries: readonly OwnRemoteProvider[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const { t } = useTranslation();
  if (entries.length === 0) return null;
  return (
    <div data-testid="own-remote-providers" className="flex flex-col gap-0.5">
      {entries.map((entry) => {
        const name = providerDisplayName(entry.provider, t);
        const label = t('settings.providers.remote.rowLabel', { provider: name, device: entry.deviceName });
        const selected = selectedKey === entry.key;
        return (
          <Tip key={entry.key} text={label} side="right" contentClassName="max-w-[360px] break-words">
            <button
              type="button"
              data-testid="own-remote-provider-row"
              aria-current={selected}
              aria-label={label}
              onClick={() => onSelect(entry.key)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg py-2 pl-3 pr-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--focus-ring-soft)]',
                selected
                  ? 'bg-[var(--settings-menu-bg-selected)]'
                  : 'hover:bg-[var(--settings-menu-bg-hover)]',
              )}
            >
              <span
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                style={{
                  backgroundColor: 'var(--settings-integration-avatar-bg)',
                  border: '1px solid var(--settings-integration-avatar-border)',
                  color: 'var(--settings-integration-avatar-icon)',
                }}
              >
                <RemoteProviderIcon provider={entry.provider} size={14} />
              </span>
              <span
                className="min-w-0 flex-1 truncate text-13 font-medium"
                style={{ color: 'var(--settings-section-title)' }}
              >
                {name}
              </span>
              <span className="shrink-0 select-none text-11 tabular-nums" style={{ color: 'var(--text-tertiary)' }}>
                {t('settings.providers.models.modelCount', {
                  count: readOnlyProviderModels(entry.provider, entry.modelVisibilityOverrides).length,
                })}
              </span>
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ backgroundColor: 'var(--remote-status-ready)' }}
              />
            </button>
          </Tip>
        );
      })}
    </div>
  );
}

/** 右栏：自己另一台电脑上的一个供应商，只读。 */
export function OwnRemoteProviderDetail({ entry }: { entry: OwnRemoteProvider }) {
  const { t } = useTranslation();
  const name = providerDisplayName(entry.provider, t);
  const models = useMemo(
    () => readOnlyProviderModels(entry.provider, entry.modelVisibilityOverrides),
    [entry.provider, entry.modelVisibilityOverrides],
  );
  return (
    <div data-testid="own-remote-provider-detail" className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 px-5 py-4">
        <div className="flex flex-wrap items-center gap-3 gap-y-2">
          <div className="flex min-w-0 flex-auto basis-[220px] items-center gap-3">
            <div
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
              style={{
                backgroundColor: 'var(--settings-integration-avatar-bg)',
                border: '1px solid var(--settings-integration-avatar-border)',
                color: 'var(--settings-integration-avatar-icon)',
              }}
            >
              <RemoteProviderIcon provider={entry.provider} size={18} />
            </div>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span
                className="min-w-0 truncate text-14 font-medium leading-tight"
                style={{ color: 'var(--settings-section-title)' }}
              >
                {name}
              </span>
              <span
                className="truncate text-13 leading-tight"
                style={{ color: 'var(--settings-integration-subtitle)' }}
              >
                {entry.deviceName}
              </span>
            </div>
          </div>
          <span role="status" className="inline-flex shrink-0 items-center gap-1.5 text-12 text-[var(--text-secondary)]">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 shrink-0 rounded-full"
              style={{ backgroundColor: 'var(--remote-status-ready)' }}
            />
            {t('settings.providers.remote.statusReady')}
          </span>
        </div>
      </div>

      <div
        className="shrink-0 border-t px-5 py-3"
        style={{ borderColor: 'var(--settings-theme-card-border)' }}
      >
        <p className="text-13 leading-[1.5]" style={{ color: 'var(--settings-section-desc)' }}>
          {t('settings.providers.remote.detailNote', { device: entry.deviceName })}
        </p>
      </div>

      <ReadOnlyProviderModelSection
        title={t('settings.providers.remote.modelsTitle')}
        models={models}
        note={models.length === 0 ? t('settings.providers.remote.modelsEmpty') : null}
        testId="own-remote-provider-models"
      />
    </div>
  );
}
