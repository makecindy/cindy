import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import type { ProviderView } from '@cindy/model-providers';

import { Select } from '@/components/ui/select';
import { useControllableDevices } from '@/hooks/useControllableDevices';
import { useDevicesProviders } from '@/hooks/useDevicesProviders';

/** Another computer on this account that offers the same provider. */
export interface RunLocationCandidate {
  deviceId: string;
  name: string;
  online: boolean;
}

const LOCAL = 'local';

/**
 * 「运行于 [电脑]」：同一个供应商只占模型列表一项，运行位置在供应商详情头的副标题行里选，
 * 和伙伴选设备一样，不另占一行。默认这台电脑；这台没登录时默认一台已登录的电脑，新电脑不用配置就能用。
 * 没有其他电脑提供这个供应商时不出现。
 */
export function ProviderRunLocationPicker({
  provider,
  candidates,
  standalone = false,
}: {
  provider: ProviderView;
  candidates: readonly RunLocationCandidate[];
  /** The picker is the whole subtitle (borrowing), so no separator before it. */
  standalone?: boolean;
}) {
  const { t } = useTranslation();
  const localUsable = provider.connected && !provider.suspended;
  const fallback = localUsable ? LOCAL : candidates.find((candidate) => candidate.online)?.deviceId ?? LOCAL;
  const [chosen, setChosen] = useState<string | null>(null);
  if (candidates.length === 0) return null;
  const value = chosen ?? fallback;
  const remote = candidates.find((candidate) => candidate.deviceId === value);
  const hint = !remote
    ? t('settings.providers.detail.runLocation.local')
    : !remote.online
      ? t('settings.providers.detail.runLocation.pinnedOffline', { device: remote.name })
      : chosen === null && !localUsable
        ? t('settings.providers.detail.runLocation.autoBorrowing', { device: remote.name })
        : t('settings.providers.detail.runLocation.pinned', { device: remote.name });
  return (
    <span data-testid="provider-run-location" className="flex shrink-0 items-center gap-1">
      {standalone ? null : <span aria-hidden="true">·</span>}
      <span>{t('settings.providers.detail.runLocation.inline')}</span>
      <Select
        label={t('settings.providers.detail.runLocation.label')}
        value={value}
        truncateOptions
        className="-my-1 h-6 w-fit max-w-[200px] gap-1 rounded-md px-1.5 text-13"
        contentClassName="w-72 max-w-[var(--radix-select-content-available-width)]"
        groups={[{
          label: hint,
          options: [
            {
              value: LOCAL,
              label: t('settings.providers.detail.runLocation.optionLocal'),
              disabled: !localUsable,
              endAdornment: localUsable ? undefined : (
                <span className="text-12 text-[var(--text-tertiary)]">
                  {t('settings.providers.detail.runLocation.notSignedIn')}
                </span>
              ),
            },
            ...candidates.map((candidate) => ({
              value: candidate.deviceId,
              label: candidate.name,
              title: candidate.name,
              endAdornment: candidate.online ? undefined : (
                <span className="text-12 text-[var(--text-tertiary)]">
                  {t('settings.providers.detail.runLocation.offline')}
                </span>
              ),
            })),
          ],
        }]}
        onValueChange={setChosen}
      />
    </span>
  );
}

/**
 * This account's other computers that offer the same provider, and — while this computer is not signed
 * in — the one new tasks borrow by default.
 */
export function useProviderBorrow(provider: ProviderView | null | undefined) {
  const devices = useControllableDevices();
  const catalogs = useDevicesProviders(provider ? devices.map((device) => device.deviceId) : []);
  const candidates: RunLocationCandidate[] = !provider || provider.suspended || provider.agents.length === 0 ? [] : devices.flatMap((device) => {
    const offered = catalogs.get(device.deviceId)?.providers.find((entry) => entry.id === provider.id);
    return offered?.connected && offered.remoteInvocationEnabled !== false
      ? [{ deviceId: device.deviceId, name: device.name, online: true }]
      : [];
  });
  const borrowed = provider && !provider.connected ? candidates.find((candidate) => candidate.online) ?? null : null;
  return { candidates, borrowed };
}

/**
 * Header subtitle with the run-location picker. While another computer is used because this one cannot
 * run the provider, the subtitle is just "Runs on <computer>": no sign-in state, nothing greyed out.
 */
export function ProviderRunLocationSubtitle({ provider, subtitle }: { provider: ProviderView; subtitle: ReactNode }) {
  const { t } = useTranslation();
  const { candidates, borrowed } = useProviderBorrow(provider);
  return (
    <>
      {borrowed ? null : <span className="min-w-0 truncate">{subtitle}</span>}
      <ProviderRunLocationPicker key={provider.id} provider={provider} candidates={candidates} standalone={borrowed !== null} />
    </>
  );
}
