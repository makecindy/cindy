/** 分享给我的供应商组：只读匿名状态。仅在详情可见时刷新，失败后不把旧状态当作仍可用。 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  PROVIDER_SHARE_GROUP_STATUS_REQUEST,
  readProviderShareGroupSize,
  readProviderShareGroupStatus,
  type ProviderShareGroupState,
} from '@cindy/device-link';

import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, isDataOwnerIdCurrent } from '@/contexts/dataOwnerGeneration';

const REFRESH_MS = 15_000;
const COPY = 'providerShare.received.groupStatus';
const isVisible = () => document.visibilityState !== 'hidden';

export function SharedProviderGroupStatus({
  deviceId, providerId, initialSize,
}: { deviceId: string; providerId: string; initialSize: number }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<{ size: number | null; states: ProviderShareGroupState[] | null }>({
    size: initialSize, states: null,
  });
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const owner = getDataOwnerGeneration();
    const current = () => !cancelled && isDataOwnerIdCurrent(owner);
    const reload = async () => {
      if (!current() || pending || !isVisible()) return;
      clearTimeout(timer);
      const generation = getDataOwnerGeneration();
      const canApply = () => current() && isDataOwnerGenerationCurrent(generation);
      pending = true;
      setLoading(true);
      try {
        const raw = await window.electronAPI.deviceLink.invoke(deviceId, 'maker:provider:list', [
          { [PROVIDER_SHARE_GROUP_STATUS_REQUEST]: true },
        ]) as { providers?: Array<{ id?: string }> };
        if (!canApply()) return;
        const provider = Array.isArray(raw?.providers) ? raw.providers.find((entry) => entry?.id === providerId) : null;
        if (!provider) throw new Error('Shared provider missing');
        setSnapshot({ size: readProviderShareGroupSize(provider), states: readProviderShareGroupStatus(provider) });
        setFailed(false);
      } catch {
        if (!canApply()) return;
        setSnapshot((previous) => ({ ...previous, states: null }));
        setFailed(true);
      } finally {
        pending = false;
        if (current()) {
          setLoading(false);
          if (isVisible()) timer = setTimeout(() => void reload(), REFRESH_MS);
        }
      }
    };
    const onVisibility = () => {
      clearTimeout(timer);
      if (isVisible()) void reload();
    };
    void reload();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [deviceId, providerId, refresh]);

  if (snapshot.size === null && !failed) return null;
  const states = snapshot.states;
  const ready = states?.filter((state) => state === 'available' || state === 'busy').length ?? 0;
  const unknown = !states || states.includes('unknown');
  const summary = failed ? t(`${COPY}.failed`)
    : !states ? t(`${COPY}.${loading ? 'loading' : 'unsupported'}`)
      : ready > 0 ? t(`${COPY}.summary`, { ready, total: states.length })
        : unknown ? t(`${COPY}.unconfirmed`) : t(`${COPY}.noneReady`);
  return (
    <section data-testid="shared-provider-group-status" className="shrink-0 border-t border-[var(--settings-theme-card-border)] px-5 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="text-13 font-medium text-[var(--settings-section-title)]">{t(`${COPY}.title`)}</h3>
        <Button variant="secondary" size="sm" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          {t(`${COPY}.refresh`)}
        </Button>
      </div>
      <p role="status" className="mb-2 text-12 leading-[1.5] text-[var(--text-secondary)]">{summary}</p>
      <ul className="max-h-64 overflow-y-auto rounded-xl border border-[var(--settings-theme-card-border)]">
        {Array.from({ length: snapshot.size ?? initialSize }, (_, index) => {
          const state = states?.[index] ?? 'unknown';
          const available = state === 'available' || state === 'busy';
          return (
            <li key={index} className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--settings-theme-card-border)] px-3 py-2.5 first:border-t-0">
              <span className="text-13 text-[var(--text-primary)]">{t(`${COPY}.computer`, { number: index + 1 })}</span>
              <span className="inline-flex items-center gap-1.5 text-12 text-[var(--text-secondary)]">
                <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: available ? 'var(--remote-status-ready)' : 'var(--remote-status-disconnected)' }} />
                {t(`${COPY}.state.${state}`)}
              </span>
            </li>
          );
        })}
      </ul>
      <p className="mt-2 text-12 leading-[1.5] text-[var(--text-tertiary)]">{t(`${COPY}.note`)}</p>
      {states?.includes('needs-update') && (
        <p className="mt-1 text-12 leading-[1.5] text-[var(--text-secondary)]">{t(`${COPY}.updateNote`)}</p>
      )}
    </section>
  );
}
