import { useMemo, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/lib/toast';

import type { ProviderView } from '@cindy/model-providers';

import { Select } from '@/components/ui/select';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { subscribeDeviceProviders } from '@/hooks/useDeviceProviders';
import { useProviderBorrow, type BorrowedProviderCatalog } from '@/hooks/useProviderBorrow';
import {
  effectiveRunLocation,
  RUN_LOCATION_LOCAL,
  type RunLocationCandidate,
} from '@/lib/providerRunLocation';
import { refreshRemoteCatalogSnapshot } from '@/lib/remoteCatalogSnapshot';

import { ReadOnlyProviderModelSection, readOnlyProviderModels } from './ReadOnlyProviderModels';

type LocatedProvider = ProviderView & { runLocation?: string };

/**
 * 「运行于 [电脑]」：同一个供应商只占模型列表一项，运行位置在供应商详情头的副标题行里选，和伙伴选设备
 * 一样，不另占一行。没有其他电脑提供这个供应商时不出现。
 */
function ProviderRunLocationPicker({
  provider,
  candidates,
  location,
  standalone,
}: {
  provider: LocatedProvider;
  candidates: readonly RunLocationCandidate[];
  location: string;
  /** 借用时选择器就是整行副标题，前面不加分隔点。 */
  standalone: boolean;
}) {
  const { t } = useTranslation();
  if (candidates.length === 0) return null;
  const localUsable = provider.connected && !provider.suspended;
  const remote = candidates.find((candidate) => candidate.deviceId === location);
  const hint = !remote
    ? t('settings.providers.detail.runLocation.local')
    : standalone
      ? t('settings.providers.detail.runLocation.autoBorrowing', { device: remote.name })
      : t('settings.providers.detail.runLocation.pinned', { device: remote.name });
  const choose = (next: string) => {
    if (next === location) return;
    // 选回默认位置就删掉覆盖，以后跟着默认走(本机登录后自动回到本机)。
    const fallback = effectiveRunLocation({ ...provider, runLocation: undefined }, candidates);
    void window.electronAPI.maker
      .setProviderRunLocation({ providerId: provider.id, location: next === fallback ? null : next })
      .catch(() => toast.error(t('settings.providers.detail.runLocation.writeFailed')));
  };
  return (
    <span data-testid="provider-run-location" className="flex shrink-0 items-center gap-1">
      {standalone ? null : <span aria-hidden="true">·</span>}
      <span>{t('settings.providers.detail.runLocation.inline')}</span>
      <Select
        data-settings-search-action="Choose which of your computers runs this provider"
        label={t('settings.providers.detail.runLocation.label')}
        value={location}
        truncateOptions
        className="-my-1 h-6 w-fit max-w-[200px] gap-1 rounded-lg px-1.5 text-13"
        contentClassName="w-72 max-w-[var(--radix-select-content-available-width)]"
        groups={[{
          label: hint,
          options: [
            {
              value: RUN_LOCATION_LOCAL,
              label: t('settings.providers.detail.runLocation.optionLocal'),
              disabled: !localUsable,
              endAdornment: localUsable ? undefined : (
                <span className="text-12 text-[var(--text-tertiary)]">
                  {t('settings.providers.detail.runLocation.notSignedIn')}
                </span>
              ),
            },
            ...candidates.map((candidate) => ({ value: candidate.deviceId, label: candidate.name, title: candidate.name })),
          ],
        }]}
        onValueChange={choose}
      />
    </span>
  );
}

/** 借用时那台电脑开放的模型数，左栏计数与详情用同一口径。 */
export function borrowedProviderModelCount(catalog: BorrowedProviderCatalog): number {
  return readOnlyProviderModels(catalog.provider, catalog.modelVisibilityOverrides).length;
}

/**
 * 借用另一台电脑时的模型区：清单、开关与刷新都属于「运行于」那台电脑，本机没登录也照常显示。
 * 开关与排序由那台电脑决定，这里只读；刷新重新读取那台电脑的目录，不调用本机的 CLI。
 */
export function BorrowedProviderModels({ catalog, device }: {
  catalog: BorrowedProviderCatalog;
  device: RunLocationCandidate;
}) {
  const { t } = useTranslation();
  const models = useMemo(
    () => readOnlyProviderModels(catalog.provider, catalog.modelVisibilityOverrides),
    [catalog.provider, catalog.modelVisibilityOverrides],
  );
  const pending = useRef(false);
  const refresh = async () => {
    if (pending.current) return;
    pending.current = true;
    const owner = getDataOwnerGeneration();
    let failed = false;
    // 预取会吞掉读取异常；订阅共享目录的实际结果，不为判断成败再发一次请求。
    const unsubscribe = subscribeDeviceProviders(device.deviceId, (event) => {
      failed = event.status === 'error';
    });
    try {
      await refreshRemoteCatalogSnapshot(device.deviceId);
    } catch {
      failed = true;
    } finally {
      unsubscribe();
      pending.current = false;
    }
    if (failed && isDataOwnerGenerationCurrent(owner)) {
      toast.error(t('settings.providers.models.refreshFailed'), {
        action: {
          label: t('settings.providers.button.retry'),
          // 失败会清掉目录并卸载模型区；重试仍属于原电脑，且不能跨账号继续。
          onClick: () => { if (isDataOwnerGenerationCurrent(owner)) void refresh(); },
        },
      });
    }
  };
  return (
    <>
      <div
        className="shrink-0 border-t px-5 py-3"
        style={{ borderColor: 'var(--settings-theme-card-border)' }}
      >
        <p className="text-13 leading-[1.5]" style={{ color: 'var(--settings-section-desc)' }}>
          {t('settings.providers.remote.detailNote', { device: device.name })}
        </p>
      </div>
      <ReadOnlyProviderModelSection
        title={t('settings.providers.remote.modelsTitle')}
        models={models}
        note={models.length === 0 ? t('settings.providers.remote.modelsEmpty') : null}
        onRefresh={() => void refresh()}
        refreshing={catalog.loading}
        testId="borrowed-provider-models"
      />
    </>
  );
}

/**
 * 供应商详情头的副标题，带「运行于」。借用另一台电脑时副标题只剩「运行于 <电脑>」：不提本机的登录状态，
 * 也不置灰任何东西。
 */
export function ProviderRunLocationSubtitle({ provider, subtitle }: { provider: ProviderView; subtitle: ReactNode }) {
  const { candidates, location, borrowed } = useProviderBorrow(provider);
  return (
    <>
      {borrowed ? null : <span className="min-w-0 truncate">{subtitle}</span>}
      <ProviderRunLocationPicker
        key={provider.id}
        provider={provider as LocatedProvider}
        candidates={candidates}
        location={location}
        standalone={borrowed !== null}
      />
    </>
  );
}
